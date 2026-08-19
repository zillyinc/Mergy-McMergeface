import { Application, Context } from 'probot'
import Raven from 'raven'

export type QueuePullRequests = (
  context: Context,
  installationId: number,
  repository: { owner: string, repo: string },
  pullRequestNumbers: number[]
) => Promise<void>

/**
 * Rebuilds the pull request queues after a (re)start.
 *
 * The queues live in memory, so a deploy or dyno restart forgets every pull
 * request that was queued or waiting. Webhooks only arrive when something
 * changes on GitHub, which means a pull request whose last event fired before
 * the restart would otherwise sit unprocessed until someone touches it. This
 * scan visits every repository of every installation once and queues all open
 * pull requests through the same path the webhook handlers use: repositories
 * without a configuration and pull requests that do not qualify for merging
 * are skipped by the regular condition evaluation.
 */
export async function scanInstallations (app: Application, queuePullRequests: QueuePullRequests): Promise<void> {
  const appGitHub = await app.auth()
  const installations: Array<{ id: number }> = await appGitHub.paginate(
    (appGitHub.apps.listInstallations as any).endpoint.merge({ per_page: 100 })
  )
  app.log(`Startup scan: rebuilding queues for ${installations.length} installation(s)`)
  for (const installation of installations) {
    try {
      await scanInstallation(app, installation.id, queuePullRequests)
    } catch (error) {
      // One broken installation must not prevent the others from being scanned.
      Raven.captureException(error, { extra: { installationId: installation.id } })
      app.log.error(`Startup scan failed for installation ${installation.id}:`, error)
    }
  }
}

async function scanInstallation (app: Application, installationId: number, queuePullRequests: QueuePullRequests): Promise<void> {
  const github = await app.auth(installationId)
  const repositories: Array<{ name: string, owner: { login: string } }> = await github.paginate(
    (github.apps.listRepos as any).endpoint.merge({ per_page: 100 })
  )
  for (const repository of repositories) {
    const owner = repository.owner.login
    const repo = repository.name
    const pullRequests: Array<{ number: number }> = await github.paginate(
      (github.pulls.list as any).endpoint.merge({ owner, repo, state: 'open', per_page: 100 })
    )
    if (pullRequests.length === 0) {
      continue
    }
    // Oldest first, approximating the order the queue would have had if no
    // webhook had been missed.
    const pullRequestNumbers = pullRequests
      .map(pullRequest => pullRequest.number)
      .sort((a, b) => a - b)
    // The webhook handlers derive repository, installation and configuration
    // from the event context; the scan synthesizes a minimal one so the same
    // code path (including configuration loading and its error handling)
    // serves both.
    const context = new Context({
      id: `startup-scan-${owner}-${repo}`,
      name: 'startup-scan',
      payload: {
        installation: { id: installationId },
        repository: {
          name: repo,
          owner: {
            login: owner
          }
        }
      }
    } as any, github, app.log)
    app.log(`Startup scan: queueing ${pullRequestNumbers.length} open pull request(s) of ${owner}/${repo}`)
    await queuePullRequests(context, installationId, { owner, repo }, pullRequestNumbers)
  }
}

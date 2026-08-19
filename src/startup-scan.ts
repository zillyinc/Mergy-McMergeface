import { Application, Context } from 'probot'
import Raven from 'raven'
import { loadConfig, ConfigNotFoundError, ConfigValidationError, Config } from './config'
import { getMissingRequiredLabels } from './conditions/requiredLabels'
import { getMissingRequiredLabelsRegex } from './conditions/requiredLabelsRegex'

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
 * scan visits every repository of every installation once and queues its open
 * pull requests through the same path the webhook handlers use.
 *
 * The scan narrows before it queues: a repository without a configuration is
 * skipped before its pull requests are even listed, and a pull request whose
 * labels cannot satisfy the global configuration's required labels is skipped
 * before the full evaluation - the pull request listing already carries the
 * labels, so this costs no extra requests, while every skipped pull request
 * saves the evaluation's GraphQL query, branch-rules lookup and check-run
 * write. Filtering on the global configuration alone is safe: rules only add
 * alternative paths on top of a passing global configuration, so a pull
 * request failing the global required labels can never merge. The full
 * condition evaluation remains authoritative for everything that is queued.
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

function couldSatisfyRequiredLabels (config: Config, labelNames: string[]): boolean {
  return getMissingRequiredLabels(config, labelNames).length === 0 &&
    getMissingRequiredLabelsRegex(config, labelNames).length === 0
}

async function scanInstallation (app: Application, installationId: number, queuePullRequests: QueuePullRequests): Promise<void> {
  const github = await app.auth(installationId)
  const repositories: Array<{ name: string, owner: { login: string } }> = await github.paginate(
    (github.apps.listRepos as any).endpoint.merge({ per_page: 100 })
  )
  for (const repository of repositories) {
    const owner = repository.owner.login
    const repo = repository.name
    // The webhook handlers derive repository, installation and configuration
    // from the event context; the scan synthesizes a minimal one so the same
    // code path serves both.
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

    let config: Config
    try {
      config = await loadConfig(context)
    } catch (error) {
      if (error instanceof ConfigNotFoundError || error instanceof ConfigValidationError) {
        // The repository does not participate in automatic merging; its pull
        // requests do not need to be listed, let alone queued.
        continue
      }
      throw error
    }

    const pullRequests: Array<{ number: number, labels?: Array<{ name: string }> }> = await github.paginate(
      (github.pulls.list as any).endpoint.merge({ owner, repo, state: 'open', per_page: 100 })
    )
    const eligiblePullRequests = pullRequests
      .filter(pullRequest => couldSatisfyRequiredLabels(config, (pullRequest.labels || []).map(label => label.name)))
    if (eligiblePullRequests.length === 0) {
      continue
    }
    // Oldest first, approximating the order the queue would have had if no
    // webhook had been missed.
    const pullRequestNumbers = eligiblePullRequests
      .map(pullRequest => pullRequest.number)
      .sort((a, b) => a - b)
    app.log(`Startup scan: queueing ${pullRequestNumbers.length} of ${pullRequests.length} open pull request(s) of ${owner}/${repo}`)
    await queuePullRequests(context, installationId, { owner, repo }, pullRequestNumbers)
  }
}

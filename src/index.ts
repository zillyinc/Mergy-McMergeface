import { Application, Context } from 'probot'
import { loadConfig } from './config'
import { WorkerContext } from './models'
import Raven from 'raven'
import { RepositoryWorkers } from './repository-workers'
import sentryStream from 'bunyan-sentry-stream'
import { RepositoryReference, PullRequestReference } from './github-models'
import myAppId from './myappid'
import { Router } from 'express'
import { GitHubAPI } from 'probot/lib/github'

async function getWorkerContext (options: {app: Application, context: Context, installationId: number}): Promise<WorkerContext> {
  const { app, context, installationId } = options
  const config = await loadConfig(context)
  const log = app.log
  const createGitHubAPI = async () => {
    return app.auth(installationId, log)
  }
  return {
    createGitHubAPI,
    log,
    config
  }
}

async function useWorkerContext (options: {app: Application, context: Context, installationId: number}, fn: (WorkerContext: WorkerContext) => Promise<void>): Promise<void> {
  await Raven.context({
    tags: {
      owner: options.context.payload.repository.owner.login,
      repository: `${options.context.payload.repository.owner.login}/${options.context.payload.repository.name}`
    },
    extra: {
      event: options.context.event
    }
  }, async () => {
    const workerContext = await getWorkerContext(options)
    await fn(workerContext)
  })
}

function setupSentry (app: Application) {
  if (process.env.NODE_ENV !== 'production') {
    Raven.disableConsoleAlerts()
  }
  Raven.config(process.env.SENTRY_DSN2, {
    captureUnhandledRejections: true,
    tags: {
      version: process.env.HEROKU_RELEASE_VERSION as string
    },
    release: process.env.SOURCE_VERSION,
    environment: process.env.NODE_ENV || 'development',
    autoBreadcrumbs: {
      'console': true,
      'http': true
    }
  }).install()

  app.log.target.addStream(sentryStream(Raven))
}

export = (app: Application) => {
  setupSentry(app)

  const repositoryWorkers = new RepositoryWorkers(
    onPullRequestError
  )

  function onPullRequestError (pullRequest: PullRequestReference, error: any) {
    const repositoryName = `${pullRequest.owner}/${pullRequest.repo}`
    const pullRequestName = `${repositoryName}#${pullRequest.number}`
    Raven.captureException(error, {
      tags: {
        owner: pullRequest.owner,
        repository: repositoryName
      },
      extra: {
        pullRequest: pullRequestName
      }
    })
    console.error(`Error while processing pull request ${pullRequestName}:`, error)
  }

  async function handlePullRequests (app: Application, context: Context, installationId: number, repository: RepositoryReference, headSha: string, pullRequestNumbers: number[]) {
    await useWorkerContext({ app, context, installationId }, async (workerContext) => {
      for (let pullRequestNumber of pullRequestNumbers) {
        repositoryWorkers.queue(workerContext, {
          owner: repository.owner,
          repo: repository.repo,
          number: pullRequestNumber
        })
      }
    })
  }

  app.on([
    'pull_request.opened',
    'pull_request.edited',
    'pull_request.reopened',
    'pull_request.synchronize',
    'pull_request.labeled',
    'pull_request.unlabeled',
    'pull_request.reopened',
    'pull_request_review.submitted',
    'pull_request_review.edited',
    'pull_request_review.dismissed',
    'pull_request.trigger'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.pull_request.head_sha, [context.payload.pull_request.number])
  })

  app.on([
    'check_run.created',
    'check_run.completed'
  ], async context => {
    if (context.payload.check_run.check_suite.app.id === myAppId) {
      return
    }

    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_run.head_sha, context.payload.check_run.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_run.rerequested',
    'check_run.requested_action'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_run.head_sha, context.payload.check_run.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_suite.requested',
    'check_suite.rerequested'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_suite.head_sha, context.payload.check_suite.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  app.on([
    'check_suite.completed'
  ], async context => {
    await handlePullRequests(app, context, context.payload.installation.id, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }, context.payload.check_suite.head_sha, context.payload.check_suite.pull_requests.map((pullRequest: any) => pullRequest.number))
  })

  const router: Router = app.route('/api')
  router.use((req, res, next) => {
    if (req.query.token !== process.env.DEBUG_TOKEN) {
      return res.status(403).send('')
    }
    return next()
  })
  router.get('/queue', (req, res) => {
    const result = Object.entries(repositoryWorkers.getRepositoryWorkers())
      .map(([name, worker]) => {
        const workerQueue = {
          current: worker.getCurrentTask(),
          queue: worker.getQueuedTasks()
        }
        return [name, workerQueue] as [string, typeof workerQueue]
      })
      .reduce((result, [name, worker]) => ({ ...result, [name]: worker }), {})
    res.json(result)
  })
  router.get('/trigger', async (req, res) => {
    const owner = req.query.owner
    const repo = req.query.repo
    const pullRequestNumber = parseInt(req.query.pullRequestNumber, 10)
    app.auth()
      .then(async (appOctokit: GitHubAPI) => {
        const { data: installation } = await appOctokit.apps.findRepoInstallation({ owner, repo })
        const event = {
          name: 'pull_request',
          payload: {
            action: 'trigger',
            installation,
            repository: {
              owner: {
                login: owner
              },
              name: repo
            },
            pull_request: {
              number: pullRequestNumber
            }
          }
        }
        await app.receive(event)
        res.json({ status: 'ok' })
      })
      .catch(err => {
        res.json({ status: 'error', error: err.toString() })
      })
  })
}

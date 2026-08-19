import { scanInstallations } from '../src/startup-scan'
import { createEmptyLogger } from './mock'
import { Application } from 'probot'

jest.mock('raven', () => ({
  captureException: jest.fn()
}))

function endpointStub (url: string) {
  return {
    endpoint: {
      merge: (options: any) => ({ url, ...options })
    }
  }
}

function createScanApp (options: {
  installations: Array<{ id: number }>,
  repositoriesByInstallation: { [id: number]: Array<{ name: string, owner: { login: string } }> },
  pullRequestsByRepository: { [fullName: string]: Array<{ number: number }> },
  failingInstallation?: number
}): Application {
  const appGitHub = {
    paginate: async (requestOptions: any) => {
      if (requestOptions.url === '/app/installations') {
        return options.installations
      }
      throw new Error(`unexpected app-level request: ${requestOptions.url}`)
    },
    apps: {
      listInstallations: endpointStub('/app/installations')
    }
  }

  const createInstallationGitHub = (installationId: number) => ({
    paginate: async (requestOptions: any) => {
      if (requestOptions.url === '/installation/repositories') {
        if (installationId === options.failingInstallation) {
          throw new Error('installation is broken')
        }
        return options.repositoriesByInstallation[installationId] || []
      }
      if (requestOptions.url === '/repos/:owner/:repo/pulls') {
        return options.pullRequestsByRepository[`${requestOptions.owner}/${requestOptions.repo}`] || []
      }
      throw new Error(`unexpected installation request: ${requestOptions.url}`)
    },
    apps: {
      listRepos: endpointStub('/installation/repositories')
    },
    pulls: {
      list: endpointStub('/repos/:owner/:repo/pulls')
    }
  })

  const app = new Application()
  app.log = createEmptyLogger()
  app.auth = ((installationId?: number) =>
    Promise.resolve((installationId === undefined
      ? appGitHub
      : createInstallationGitHub(installationId)) as any)
  ) as any
  return app
}

describe('scanInstallations', () => {
  it('queues the open pull requests of every installation repository, oldest first', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [
          { name: 'zilly-backend', owner: { login: 'zillyinc' } },
          { name: 'tellus-webapp', owner: { login: 'zillyinc' } }
        ]
      },
      pullRequestsByRepository: {
        'zillyinc/zilly-backend': [{ number: 9 }, { number: 2 }, { number: 5 }],
        'zillyinc/tellus-webapp': [{ number: 494 }]
      }
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).toHaveBeenCalledTimes(2)
    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          installation: { id: 1 },
          repository: { name: 'zilly-backend', owner: { login: 'zillyinc' } }
        })
      }),
      1,
      { owner: 'zillyinc', repo: 'zilly-backend' },
      [2, 5, 9]
    )
    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.anything(),
      1,
      { owner: 'zillyinc', repo: 'tellus-webapp' },
      [494]
    )
  })

  it('does not queue repositories without open pull requests', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [{ name: 'empty-repo', owner: { login: 'zillyinc' } }]
      },
      pullRequestsByRepository: {}
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).not.toHaveBeenCalled()
  })

  it('continues with the remaining installations when one fails', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }, { id: 2 }],
      repositoriesByInstallation: {
        2: [{ name: 'zilly-backend', owner: { login: 'zillyinc' } }]
      },
      pullRequestsByRepository: {
        'zillyinc/zilly-backend': [{ number: 3 }]
      },
      failingInstallation: 1
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).toHaveBeenCalledTimes(1)
    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.anything(),
      2,
      { owner: 'zillyinc', repo: 'zilly-backend' },
      [3]
    )
  })
})

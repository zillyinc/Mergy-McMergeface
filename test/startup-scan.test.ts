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

type RepoFixture = {
  name: string,
  owner: { login: string },
  // Config file content; undefined simulates a repository without one.
  config?: string,
  pullRequests?: Array<{ number: number, labels?: Array<{ name: string }> }>
}

function createScanApp (options: {
  installations: Array<{ id: number }>,
  repositoriesByInstallation: { [id: number]: RepoFixture[] },
  failingInstallation?: number
}): Application & { pullRequestListings: string[] } {
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

  const pullRequestListings: string[] = []

  const createInstallationGitHub = (installationId: number) => {
    const repositories = options.repositoriesByInstallation[installationId] || []
    const findRepo = (owner: string, name: string) =>
      repositories.find(repository => repository.owner.login === owner && repository.name === name)
    return {
      paginate: async (requestOptions: any) => {
        if (requestOptions.url === '/installation/repositories') {
          if (installationId === options.failingInstallation) {
            throw new Error('installation is broken')
          }
          return repositories
        }
        if (requestOptions.url === '/repos/:owner/:repo/pulls') {
          pullRequestListings.push(`${requestOptions.owner}/${requestOptions.repo}`)
          const repository = findRepo(requestOptions.owner, requestOptions.repo)
          return (repository && repository.pullRequests) || []
        }
        throw new Error(`unexpected installation request: ${requestOptions.url}`)
      },
      apps: {
        listRepos: endpointStub('/installation/repositories')
      },
      pulls: {
        list: endpointStub('/repos/:owner/:repo/pulls')
      },
      repos: {
        getContents: ({ owner, repo, path }: { owner: string, repo: string, path: string }) => {
          const repository = findRepo(owner, repo)
          if (!repository || repository.config === undefined || path !== '.github/auto-merge.yml') {
            const error: any = new Error(`Not found: ${owner}/${repo}/${path}`)
            error.code = 404
            return Promise.reject(error)
          }
          return Promise.resolve({
            status: 200,
            data: {
              content: Buffer.from(repository.config).toString('base64')
            }
          })
        }
      }
    }
  }

  const app: any = new Application()
  app.log = createEmptyLogger()
  app.auth = ((installationId?: number) =>
    Promise.resolve((installationId === undefined
      ? appGitHub
      : createInstallationGitHub(installationId)) as any)
  ) as any
  app.pullRequestListings = pullRequestListings
  return app
}

const approvedLabelConfig = `
requiredLabels:
- approved
`

describe('scanInstallations', () => {
  it('queues only the pull requests whose labels can satisfy the required labels, oldest first', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [{
          name: 'zilly-backend',
          owner: { login: 'zillyinc' },
          config: approvedLabelConfig,
          pullRequests: [
            { number: 9, labels: [{ name: 'approved' }] },
            { number: 2, labels: [{ name: 'approved' }, { name: 'size/M' }] },
            { number: 5, labels: [{ name: 'size/L' }] },
            { number: 7, labels: [] },
            { number: 8 }
          ]
        }]
      }
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).toHaveBeenCalledTimes(1)
    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          installation: { id: 1 },
          repository: { name: 'zilly-backend', owner: { login: 'zillyinc' } }
        })
      }),
      1,
      { owner: 'zillyinc', repo: 'zilly-backend' },
      [2, 9]
    )
  })

  it('queues every open pull request when the configuration requires no labels', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [{
          name: 'anything-goes',
          owner: { login: 'zillyinc' },
          config: 'minApprovals:\n  OWNER: 1\n',
          pullRequests: [
            { number: 3, labels: [] },
            { number: 1 }
          ]
        }]
      }
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.anything(),
      1,
      { owner: 'zillyinc', repo: 'anything-goes' },
      [1, 3]
    )
  })

  it('skips repositories without a configuration before listing their pull requests', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [
          {
            name: 'no-config-repo',
            owner: { login: 'zillyinc' },
            pullRequests: [{ number: 4, labels: [{ name: 'approved' }] }]
          },
          {
            name: 'zilly-backend',
            owner: { login: 'zillyinc' },
            config: approvedLabelConfig,
            pullRequests: [{ number: 6, labels: [{ name: 'approved' }] }]
          }
        ]
      }
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(app.pullRequestListings).toEqual(['zillyinc/zilly-backend'])
    expect(queuePullRequests).toHaveBeenCalledTimes(1)
    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.anything(),
      1,
      { owner: 'zillyinc', repo: 'zilly-backend' },
      [6]
    )
  })

  it('applies requiredLabelsRegex to the pre-filter as well', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }],
      repositoriesByInstallation: {
        1: [{
          name: 'regex-repo',
          owner: { login: 'zillyinc' },
          config: 'requiredLabelsRegex:\n- "^ready"\n',
          pullRequests: [
            { number: 11, labels: [{ name: 'ready-to-ship' }] },
            { number: 12, labels: [{ name: 'blocked' }] }
          ]
        }]
      }
    })

    const queuePullRequests = jest.fn(() => Promise.resolve())
    await scanInstallations(app, queuePullRequests)

    expect(queuePullRequests).toHaveBeenCalledWith(
      expect.anything(),
      1,
      { owner: 'zillyinc', repo: 'regex-repo' },
      [11]
    )
  })

  it('continues with the remaining installations when one fails', async () => {
    const app = createScanApp({
      installations: [{ id: 1 }, { id: 2 }],
      repositoriesByInstallation: {
        2: [{
          name: 'zilly-backend',
          owner: { login: 'zillyinc' },
          config: approvedLabelConfig,
          pullRequests: [{ number: 3, labels: [{ name: 'approved' }] }]
        }]
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

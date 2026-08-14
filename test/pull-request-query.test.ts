import { queryPullRequest } from '../src/pull-request-query'
import { createGithubApi, createPullRequestInfo, createPullRequestQuery, createOkEndpoint, GraphqlError } from './mock'

function createPaginate (rules: any[]) {
  return jest.fn(() => Promise.resolve(rules)) as any
}

describe('queryPullRequest', () => {
  it('should do a single graphql query', async () => {
    const pullRequestInfo = createPullRequestInfo()
    const graphql = jest.fn(() => ({
      repository: {
        pullRequest: {
          ...pullRequestInfo
        }
      }
    }))
    const listForRef = createOkEndpoint({
      data: {
        check_runs: []
      }
    })
    await queryPullRequest(
      createGithubApi({
        graphql,
        paginate: createPaginate([]),
        checks: {
          listForRef
        }
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('should populate ruleset required status check contexts from the branch rules endpoint', async () => {
    const pullRequestInfo = createPullRequestInfo()
    const graphql = jest.fn(() => createPullRequestQuery(pullRequestInfo))
    const paginate = createPaginate([{
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'build' }, { context: 'test' }]
      }
    }, {
      type: 'pull_request',
      parameters: {}
    }, {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'lint' }]
      }
    }])
    const result = await queryPullRequest(
      createGithubApi({
        graphql,
        paginate
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )
    expect(paginate).toHaveBeenCalledWith('GET /repos/:owner/:repo/rules/branches/:branch', {
      owner: 'bobvanderlinden',
      repo: 'probot-auto-merge',
      branch: 'master',
      per_page: 100
    })
    expect(result.rulesetRequiredStatusCheckContexts).toEqual(['build', 'test', 'lint'])
  })

  it('should yield no ruleset required status check contexts when the branch rules request fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const pullRequestInfo = createPullRequestInfo()
      const graphql = jest.fn(() => createPullRequestQuery(pullRequestInfo))
      const paginate = jest.fn(() => Promise.reject(new Error('Resource not accessible by integration'))) as any
      const result = await queryPullRequest(
        createGithubApi({
          graphql,
          paginate
        }),
        { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
      )
      expect(result.rulesetRequiredStatusCheckContexts).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('should throw error when no query response', async () => {
    const graphql = jest.fn(() => null)
    expect(queryPullRequest(
      createGithubApi({
        graphql
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )).rejects.toThrowError('Could not query pull request')
  })

  it('should throw error when empty query response', async () => {
    const graphql = jest.fn(() => ({}))
    expect(queryPullRequest(
      createGithubApi({
        graphql
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )).rejects.toThrowError('Query result does not have repository')
  })

  it('should throw error when no headRef and not mergeable', async () => {
    const graphql = jest.fn(() => createPullRequestInfo({
      repository: {
        pullRequest: {
          headRef: undefined,
          mergeable: undefined
        }
      }
    } as any))
    expect(queryPullRequest(
      createGithubApi({
        graphql
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )).rejects.toThrowError('No permission to source repository of pull request')
  })

  it('should captureError on query error', async () => {
    const Raven = require('raven')
    const captureException = jest.fn()
    Raven.captureException = captureException
    const queryResult = createPullRequestQuery(createPullRequestInfo())
    const graphql = jest.fn(() => {
      throw new GraphqlError({
        errors: [{
          extensions: [],
          locations: [],
          message: '',
          path: ['repository', 'some', 'field']
        }],
        data: queryResult
      })
    })
    await queryPullRequest(
      createGithubApi({
        graphql,
        paginate: createPaginate([])
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )
    expect(captureException).toBeCalled()
  })

  it('should captureError on query error', async () => {
    const Raven = require('raven')
    const captureException = jest.fn()
    Raven.captureException = captureException
    const queryResult = createPullRequestQuery(createPullRequestInfo())
    const graphql = jest.fn(() => {
      throw new GraphqlError({
        errors: [{
          extensions: [],
          locations: [],
          message: '',
          path: [
            'repository',
            'pullRequest',
            'commits',
            'nodes',
            0,
            'commit',
            'checkSuites',
            'nodes',
            2,
            'app'
          ]
        }],
        data: queryResult
      })
    })
    await queryPullRequest(
      createGithubApi({
        graphql,
        paginate: createPaginate([])
      }),
      { owner: 'bobvanderlinden', repo: 'probot-auto-merge', number: 1 }
    )
    expect(captureException).not.toBeCalled()
  })
})

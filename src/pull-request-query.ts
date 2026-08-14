import Raven from 'raven'
import { PullRequestReference, PullRequestInfo, PullRequestQueryPullRequest, validatePullRequestQuery } from './github-models'
import { PullRequestQueryVariables, PullRequestQuery } from './query.graphql'
import { Context } from 'probot'
import { GitHubAPI } from 'probot/lib/github'
import { readFileSync } from 'fs'
import { join } from 'path'
import { rawGraphQLQuery } from './github-utils'
import { flatMap } from './utils'
const query = readFileSync(join(__dirname, '..', 'query.graphql'), 'utf8')

const isNumber = (v: string | number) => typeof v === 'number'
type Matcher = string | number | ((v: string | number) => boolean)

function matchPath (expected: Matcher[], actual: (string | number)[]): boolean {
  const endOfPath = Symbol('endOfPath')
  const expectedWithEOP = [...expected, endOfPath]
  const actualWithEOP = [...actual, endOfPath]
  return expectedWithEOP.every((expectedMatch, index) => {
    return (typeof expectedMatch === 'function' && expectedMatch(actual[index])) ||
      (expectedMatch === actualWithEOP[index])
  })
}

const appPath = [
  'repository',
  'pullRequest',
  'commits',
  'nodes',
  isNumber,
  'commit',
  'checkSuites',
  'nodes',
  isNumber,
  'app'
]

export async function graphQLQuery (github: GitHubAPI, variables: PullRequestQueryVariables): Promise<PullRequestQuery> {
  const response = await rawGraphQLQuery(github, query, variables, {
    Accept: 'application/vnd.github.antiope-preview+json, application/vnd.github.merge-info-preview+json'
  })
  if (response.errors) {
    // Remove error related to permissions for fetching app id of checkSuites.
    // These errors cannot be  avoided, as auto-merge wants to fetch which checkSuites are its own.
    // Attemping to fetch other checkSuites, where auto-merge doesn't have permissions for, is an side-effect.
    const actualErrors = response.errors.filter(error => !(error.path && matchPath(appPath, error.path)))
    if (actualErrors.length > 0) {
      Raven.captureException(new Error('GraphQL error'), {
        extra: {
          response
        }
      })
    }
  }
  return response.data as PullRequestQuery
}

type BranchRule = {
  type: string,
  parameters?: {
    required_status_checks?: Array<{ context: string }>
  }
}

async function queryRulesetRequiredStatusCheckContexts (github: Context['github'], owner: string, repo: string, branch: string): Promise<string[]> {
  try {
    const rules: BranchRule[] = await github.paginate('GET /repos/:owner/:repo/rules/branches/:branch', {
      owner,
      repo,
      branch: encodeURIComponent(branch),
      per_page: 100
    })
    return flatMap(
      rules.filter(rule => rule.type === 'required_status_checks'),
      rule => ((rule.parameters && rule.parameters.required_status_checks) || []).map(check => check.context)
    )
  } catch (error) {
    // When this call fails the ruleset-required contexts are unknown, so their
    // enforcement falls back to GitHub's own mergeStateStatus gate.
    console.warn(`Failed to fetch branch rules for ${owner}/${repo}@${branch}: ${error}`)
    return []
  }
}

export async function queryPullRequest (github: Context['github'], { owner, repo, number: pullRequestNumber }: PullRequestReference): Promise<PullRequestInfo> {
  const response = await graphQLQuery(github, {
    owner: owner,
    repo: repo,
    pullRequestNumber: pullRequestNumber
  })

  const pullRequest: PullRequestQueryPullRequest = Raven.context({
    extras: { response }
  }, () => {
    const checkedResponse = validatePullRequestQuery(response)
    return checkedResponse.repository.pullRequest
  })

  const rulesetRequiredStatusCheckContexts = await queryRulesetRequiredStatusCheckContexts(github, owner, repo, pullRequest.baseRef.name)

  return {
    ...pullRequest,
    rulesetRequiredStatusCheckContexts
  }
}

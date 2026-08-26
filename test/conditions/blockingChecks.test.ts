import blockingChecks from '../../src/conditions/blockingChecks'
import { createConditionConfig, createPullRequestInfo, createCheckRun, createMasterRef, createCommit, createCheckSuite, createCommitsWithCheckSuiteWithCheckRun, failedCheckRun } from '../mock'
import { CheckStatusState, CheckConclusionState, PullRequestInfo } from '../../src/models'
import { CheckRun, CommitStatusContext, StatusState } from '../../src/github-models'

function createRepositoryWithRules (rules: Array<{ pattern: string, requiredStatusCheckContexts: string[] }>): PullRequestInfo['repository'] {
  return {
    branchProtectionRules: {
      nodes: rules.map(rule => ({
        restrictsPushes: true,
        requiresStrictStatusChecks: true,
        ...rule
      }))
    }
  }
}

function createCommitsWithCheckRuns (checkRuns: Array<Partial<CheckRun>>, statusContexts?: CommitStatusContext[]): PullRequestInfo['commits'] {
  return {
    nodes: [createCommit({
      status: statusContexts ? { contexts: statusContexts } : null,
      checkSuites: {
        nodes: [createCheckSuite({
          checkRuns: {
            nodes: checkRuns.map(createCheckRun)
          }
        })]
      }
    })]
  }
}

function createCommitsWithCheckRunsInSeparateSuites (checkRuns: Array<Partial<CheckRun>>): PullRequestInfo['commits'] {
  return {
    nodes: [createCommit({
      status: null,
      checkSuites: {
        nodes: checkRuns.map(checkRun => createCheckSuite({
          checkRuns: {
            nodes: [createCheckRun(checkRun)]
          }
        }))
      }
    })]
  }
}

describe('blockingChecks', () => {
  it('returns success when a non-required check is in progress', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          name: 'optional-check',
          status: CheckStatusState.IN_PROGRESS,
          conclusion: null
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when a non-required check failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          name: 'optional-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns pending when a required check is in progress', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'required-check',
            status: CheckStatusState.IN_PROGRESS,
            conclusion: null
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns pending when a required check is queued', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'required-check',
            status: CheckStatusState.QUEUED,
            conclusion: null
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns fail when a required check failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'required-check',
            status: CheckStatusState.COMPLETED,
            conclusion: CheckConclusionState.FAILURE
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns pending when a required check has no matching check run', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'some-other-check',
            status: CheckStatusState.COMPLETED,
            conclusion: CheckConclusionState.SUCCESS
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns success when there are no branch protection rules even with a failing check', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: failedCheckRun
        }),
        baseRef: createMasterRef()
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when no branch protection rule matches the base branch even with a failing check', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            ...failedCheckRun,
            name: 'required-check'
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'develop',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns fail when a required check fails under a glob-matching protection rule', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'required-check',
            status: CheckStatusState.COMPLETED,
            conclusion: CheckConclusionState.FAILURE
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'ma*',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns success when all required checks succeeded amongst failing non-required checks', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check-1',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          name: 'required-check-2',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.NEUTRAL
        }, {
          name: 'optional-check-1',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }, {
          name: 'optional-check-2',
          status: CheckStatusState.QUEUED,
          conclusion: null
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check-1', 'required-check-2']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when a required check was skipped', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: {
            name: 'required-check',
            status: CheckStatusState.COMPLETED,
            conclusion: CheckConclusionState.SKIPPED
          }
        }),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('applies only the rule with the exact branch name when a glob rule also matches', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'ma*',
          requiredStatusCheckContexts: ['glob-only-check']
        }, {
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('applies only the earliest-created rule when multiple glob rules match', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'ma*',
          requiredStatusCheckContexts: ['required-check']
        }, {
          pattern: '*',
          requiredStatusCheckContexts: ['other-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when a required context is satisfied by a successful commit status', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([], [{
          context: 'continuous-integration/jenkins',
          state: StatusState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['continuous-integration/jenkins']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns pending when a required commit status is pending', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([], [{
          context: 'continuous-integration/jenkins',
          state: StatusState.PENDING
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['continuous-integration/jenkins']
        }])
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns fail when a required commit status failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([], [{
          context: 'continuous-integration/jenkins',
          state: StatusState.FAILURE
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['continuous-integration/jenkins']
        }])
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns fail when a required commit status errored', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([], [{
          context: 'continuous-integration/jenkins',
          state: StatusState.ERROR
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['continuous-integration/jenkins']
        }])
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns success when required contexts are satisfied by a mix of check runs and commit statuses', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'build',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }], [{
          context: 'continuous-integration/jenkins',
          state: StatusState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['build', 'continuous-integration/jenkins']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('ignores the own status report check when it is a required context', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['auto-merge']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns pending when a ruleset-required check has no matching check run', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'some-other-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: ['required-check']
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns pending when a ruleset-required check is in progress', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.IN_PROGRESS,
          conclusion: null
        }]),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: ['required-check']
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns fail when a ruleset-required check failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }]),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: ['required-check']
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns success when all ruleset-required checks succeeded', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: ['required-check']
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns pending when branch protection checks succeeded but a ruleset-required check is missing', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'classic-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['classic-check']
        }]),
        rulesetRequiredStatusCheckContexts: ['ruleset-check']
      })
    )
    expect(result.status).toBe('pending')
  })

  it('returns fail when branch protection checks succeeded but a ruleset-required check failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'classic-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          name: 'ruleset-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['classic-check']
        }]),
        rulesetRequiredStatusCheckContexts: ['ruleset-check']
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns fail when ruleset-required checks succeeded but a branch protection check failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'classic-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }, {
          name: 'ruleset-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['classic-check']
        }]),
        rulesetRequiredStatusCheckContexts: ['ruleset-check']
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns success when both branch protection and ruleset-required checks succeeded', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'classic-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          name: 'ruleset-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['classic-check']
        }]),
        rulesetRequiredStatusCheckContexts: ['ruleset-check']
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when there are no branch protection rules and no ruleset contexts even with a failing check', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckSuiteWithCheckRun({
          checkRun: failedCheckRun
        }),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: []
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('ignores the own status report check when it is a ruleset-required context', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([]),
        baseRef: createMasterRef(),
        rulesetRequiredStatusCheckContexts: ['auto-merge']
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('evaluates other required contexts when the own status report check is also required', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRuns([{
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['auto-merge', 'required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns success when a required check failed in a superseded check suite and succeeded in the latest one', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRunsInSeparateSuites([{
          databaseId: 1,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }, {
          databaseId: 2,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('takes the newest check run rather than the last listed one', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRunsInSeparateSuites([{
          databaseId: 2,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          databaseId: 1,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns fail when the newest check run for a required check failed after an older one succeeded', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRunsInSeparateSuites([{
          databaseId: 1,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }, {
          databaseId: 2,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('fail')
  })

  it('returns success when a required check is left in progress in a superseded check suite', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRunsInSeparateSuites([{
          databaseId: 1,
          name: 'required-check',
          status: CheckStatusState.IN_PROGRESS,
          conclusion: null
        }, {
          databaseId: 2,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.SUCCESS
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result).toEqual({ status: 'success' })
  })

  it('returns pending when a required check was restarted after an older run failed', () => {
    const result = blockingChecks(
      createConditionConfig(),
      createPullRequestInfo({
        commits: createCommitsWithCheckRunsInSeparateSuites([{
          databaseId: 1,
          name: 'required-check',
          status: CheckStatusState.COMPLETED,
          conclusion: CheckConclusionState.FAILURE
        }, {
          databaseId: 2,
          name: 'required-check',
          status: CheckStatusState.IN_PROGRESS,
          conclusion: null
        }]),
        baseRef: createMasterRef(),
        repository: createRepositoryWithRules([{
          pattern: 'master',
          requiredStatusCheckContexts: ['required-check']
        }])
      })
    )
    expect(result.status).toBe('pending')
  })
})

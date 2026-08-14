import { ConditionConfig } from './../config'
import { PullRequestInfo } from '../models'
import { ConditionResult } from '../condition'
import minimatch from 'minimatch'
import { BranchProtectionRule, CheckRun, CheckConclusionState, CheckStatusState, CommitStatusContext, StatusState } from '../github-models'
import { flatMap, getOtherCheckRuns } from '../utils'
import { statusReportCheckName } from '../status-report'

const positiveCheckRunConclusions: Array<CheckRun['conclusion']> = [
  CheckConclusionState.SUCCESS,
  CheckConclusionState.NEUTRAL,
  CheckConclusionState.SKIPPED
]

const pendingStatusStates: StatusState[] = [
  StatusState.PENDING,
  StatusState.EXPECTED
]

function isPositiveCheckRun (checkRun: CheckRun): boolean {
  return positiveCheckRunConclusions.indexOf(checkRun.conclusion) > -1
}

function getApplicableBranchProtectionRule (pullRequestInfo: PullRequestInfo): BranchProtectionRule | undefined {
  const rules = pullRequestInfo.repository.branchProtectionRules.nodes
  const baseRefName = pullRequestInfo.baseRef.name
  return rules.find(rule => rule.pattern === baseRefName) ||
    rules.find(rule => minimatch(baseRefName, rule.pattern))
}

function getStatusContexts (pullRequestInfo: PullRequestInfo): CommitStatusContext[] {
  return flatMap(pullRequestInfo.commits.nodes,
    commit => commit.commit.status ? commit.commit.status.contexts : []
  )
}

function getRequiredContexts (pullRequestInfo: PullRequestInfo): string[] {
  const applicableRule = getApplicableBranchProtectionRule(pullRequestInfo)
  const branchProtectionContexts = applicableRule
    ? applicableRule.requiredStatusCheckContexts
    : []
  const allContexts = branchProtectionContexts.concat(pullRequestInfo.rulesetRequiredStatusCheckContexts)
  return allContexts
    .filter((context, index) => allContexts.indexOf(context) === index)
    .filter(context => context !== statusReportCheckName)
}

export default function doesNotHaveBlockingChecks (
  config: ConditionConfig,
  pullRequestInfo: PullRequestInfo
): ConditionResult {
  const requiredContexts = getRequiredContexts(pullRequestInfo)

  if (requiredContexts.length === 0) {
    return {
      status: 'success'
    }
  }

  const checkRuns = getOtherCheckRuns(pullRequestInfo)
  const statusContexts = getStatusContexts(pullRequestInfo)

  const allRequiredChecksExist = requiredContexts
    .every(requiredContext =>
      checkRuns.some(checkRun => checkRun.name === requiredContext) ||
      statusContexts.some(statusContext => statusContext.context === requiredContext)
    )

  if (!allRequiredChecksExist) {
    return {
      status: 'pending',
      message: 'Required checks are missing'
    }
  }

  const requiredCheckRuns = checkRuns
    .filter(checkRun => requiredContexts.indexOf(checkRun.name) > -1)
  const requiredStatusContexts = statusContexts
    .filter(statusContext => requiredContexts.indexOf(statusContext.context) > -1)

  const hasPendingRequiredChecks =
    requiredCheckRuns.some(checkRun => checkRun.status !== CheckStatusState.COMPLETED) ||
    requiredStatusContexts.some(statusContext => pendingStatusStates.indexOf(statusContext.state) > -1)

  if (hasPendingRequiredChecks) {
    return {
      status: 'pending',
      message: 'There are still pending required checks'
    }
  }

  const allRequiredChecksPositive =
    requiredCheckRuns.every(isPositiveCheckRun) &&
    requiredStatusContexts.every(statusContext => statusContext.state === StatusState.SUCCESS)

  if (!allRequiredChecksPositive) {
    return {
      status: 'fail',
      message: 'There are blocking required checks'
    }
  }

  return {
    status: 'success'
  }
}

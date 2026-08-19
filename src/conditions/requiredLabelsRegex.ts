import { ConditionConfig } from '../config'
import { ConditionResult } from '../condition'
import { PullRequestInfo } from '../models'

export function getMissingRequiredLabelsRegex (
  config: ConditionConfig,
  labels: string[]
): string[] {
  const pullRequestLabels = Array.from(new Set(labels))

  return config.requiredLabelsRegex
    .map(function (pattern) {
      const regexObj = new RegExp(pattern, 'ig')
      const matchingLabelExist = pullRequestLabels.some(label => regexObj.test(label))
      if (matchingLabelExist) {
        return null
      } else {
        return pattern
      }
    })
    .filter((label): label is string => label != null)
}

export default function hasRequiredLabelsRegex (
  config: ConditionConfig,
  pullRequestInfo: PullRequestInfo
): ConditionResult {
  const requiredLabelsRegexMissingMatch = getMissingRequiredLabelsRegex(
    config,
    pullRequestInfo.labels.nodes.map(label => label.name)
  )

  if (requiredLabelsRegexMissingMatch.length > 0) {
    return {
      status: 'fail',
      message: `Required labels matching regular expression(s) are missing (${
        requiredLabelsRegexMissingMatch.join(', ')
      })`
    }
  }
  return {
    status: 'success'
  }
}

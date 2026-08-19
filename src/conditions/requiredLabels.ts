import { ConditionConfig } from './../config'
import { PullRequestInfo } from '../models'
import { ConditionResult } from '../condition'
import { matchesPattern, stringifyPattern, Pattern } from '../pattern'

export function getMissingRequiredLabels (
  config: ConditionConfig,
  pullRequestLabels: string[]
): Pattern[] {
  return config.requiredLabels
    .filter(requiredLabelPattern => !pullRequestLabels.some(pullRequestLabel => matchesPattern(requiredLabelPattern, pullRequestLabel)))
}

export default function hasRequiredLabels (
  config: ConditionConfig,
  pullRequestInfo: PullRequestInfo
): ConditionResult {
  const pullRequestLabels = pullRequestInfo.labels.nodes.map(label => label.name)

  const missingRequiredLabelPatterns = getMissingRequiredLabels(config, pullRequestLabels)

  if (missingRequiredLabelPatterns.length > 0) {
    return {
      status: 'fail',
      message: `Required labels are missing (${
        missingRequiredLabelPatterns.map(stringifyPattern).join(', ')
      })`
    }
  }
  return {
    status: 'success'
  }
}

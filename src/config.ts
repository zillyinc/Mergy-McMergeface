import { CommentAuthorAssociation } from './github-models'
import { Context } from 'probot'
import getConfig from 'probot-config'
import { Decoder, object, string, optional, number, boolean, array, oneOf, constant } from '@mojotech/json-type-validation'
import { Pattern, patternDecoder } from './pattern'

export class ConfigNotFoundError extends Error {
  constructor (
    public readonly filePath: string
  ) {
    super(`Configuration file '${filePath}' not found`)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class ConfigValidationError extends Error {
  constructor (
    public readonly decoderError: {
      at: string,
      message: string
    },
    public readonly config: any
  ) {
    super(`Configuration invalid: ${decoderError.message}: ${decoderError.at}`)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type ConditionConfig = {
  minApprovals: { [key in CommentAuthorAssociation]?: number },
  requiredReviewers: string[],
  maxRequestedChanges: { [key in CommentAuthorAssociation]?: number },
  requiredLabels: Pattern[],
  blockingLabels: Pattern[],
  requiredLabelsRegex: string[],
  blockingLabelsRegex: string[],
  requiredTitleRegex: string | undefined,
  blockingTitleRegex: string | undefined,
  requiredBodyRegex: string | undefined,
  blockingBodyRegex: string | undefined,
  requiredBaseBranches: Pattern[],
  blockingBaseBranches: Pattern[],
  requiredAuthorRole: CommentAuthorAssociation,
}

export type Config = {
  rules: ConditionConfig[],
  updateBranch: boolean,
  deleteBranchAfterMerge: boolean,
  mergeMethod: 'merge' | 'rebase' | 'squash'
  mergeCommitMessage?: string
  reportStatus: boolean
} & ConditionConfig

export const defaultRuleConfig: ConditionConfig = {
  minApprovals: {
  },
  requiredReviewers: [],
  maxRequestedChanges: {
    NONE: 0
  },
  requiredLabels: [],
  blockingLabels: [],
  requiredLabelsRegex: [],
  blockingLabelsRegex: [],
  requiredTitleRegex: undefined,
  blockingTitleRegex: undefined,
  requiredBodyRegex: undefined,
  blockingBodyRegex: undefined,
  blockingBaseBranches: [],
  requiredBaseBranches: [],
  requiredAuthorRole: CommentAuthorAssociation.NONE
}

export const defaultConfig: Config = {
  rules: [],
  updateBranch: false,
  deleteBranchAfterMerge: false,
  mergeMethod: 'merge',
  reportStatus: false,
  ...defaultRuleConfig
}

const commentAuthorAssociation: Decoder<CommentAuthorAssociation> = oneOf(
  constant(CommentAuthorAssociation.MEMBER),
  constant(CommentAuthorAssociation.OWNER),
  constant(CommentAuthorAssociation.COLLABORATOR),
  constant(CommentAuthorAssociation.CONTRIBUTOR),
  constant(CommentAuthorAssociation.FIRST_TIME_CONTRIBUTOR),
  constant(CommentAuthorAssociation.FIRST_TIMER),
  constant(CommentAuthorAssociation.NONE)
)

const reviewConfigDecover: Decoder<{ [key in CommentAuthorAssociation]: number | undefined }> = object({
  MEMBER: optional(number()),
  OWNER: optional(number()),
  COLLABORATOR: optional(number()),
  CONTRIBUTOR: optional(number()),
  FIRST_TIME_CONTRIBUTOR: optional(number()),
  FIRST_TIMER: optional(number()),
  NONE: optional(number())
})

const conditionConfigDecoder: Decoder<ConditionConfig> = object({
  minApprovals: reviewConfigDecover,
  requiredReviewers: array(string()),
  maxRequestedChanges: reviewConfigDecover,
  requiredBaseBranches: array(patternDecoder),
  blockingBaseBranches: array(patternDecoder),
  requiredLabels: array(patternDecoder),
  blockingLabels: array(patternDecoder),
  requiredLabelsRegex: array(string()),
  blockingLabelsRegex: array(string()),
  requiredTitleRegex: optional(string()),
  blockingTitleRegex: optional(string()),
  requiredBodyRegex: optional(string()),
  blockingBodyRegex: optional(string()),
  requiredAuthorRole: commentAuthorAssociation,
})

const configDecoder: Decoder<Config> = object({
  rules: array(conditionConfigDecoder),
  minApprovals: reviewConfigDecover,
  requiredReviewers: array(string()),
  maxRequestedChanges: reviewConfigDecover,
  requiredLabels: array(patternDecoder),
  blockingLabels: array(patternDecoder),
  requiredLabelsRegex: array(string()),
  blockingLabelsRegex: array(string()),
  requiredTitleRegex: optional(string()),
  blockingTitleRegex: optional(string()),
  requiredBodyRegex: optional(string()),
  blockingBodyRegex: optional(string()),
  requiredBaseBranches: array(patternDecoder),
  blockingBaseBranches: array(patternDecoder),
  requiredAuthorRole: commentAuthorAssociation,
  updateBranch: boolean(),
  deleteBranchAfterMerge: boolean(),
  reportStatus: boolean(),
  mergeMethod: oneOf(
    constant<'merge'>('merge'),
    constant<'rebase'>('rebase'),
    constant<'squash'>('squash')
  ),
  mergeCommitMessage: optional(string())
})

export function validateConfig (config: any) {
  return configDecoder.run(config)
}

export function getConfigFromUserConfig (userConfig: any): Config {
  const config = {
    ...defaultConfig,
    ...userConfig,
    rules: (userConfig.rules || []).map((rule: any) => ({
      ...defaultRuleConfig,
      ...rule
    }))
  }
  const decoded = configDecoder.run(config)
  if (!decoded.ok) {
    throw new ConfigValidationError(decoded.error, config)
  }
  return decoded.result
}

export async function loadConfig (context: Context): Promise<Config> {
  const userConfig = await getConfig(context, 'auto-merge.yml', null)
  if (!userConfig) {
    throw new ConfigNotFoundError('.github/auto-merge.yml')
  }
  return getConfigFromUserConfig(userConfig)
}

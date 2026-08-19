import Raven from 'raven'
import { WaitQueue } from './WaitQueue'
import { RepositoryReference, PullRequestReference } from './github-models'
import { handlePullRequest, PullRequestContext, QueuePosition } from './pull-request-handler'
import { WorkerContext } from './models'

export class RepositoryWorker {
  private waitQueue: WaitQueue<number>
  private context: WorkerContext
  private pollTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()

  constructor (
    public repository: RepositoryReference,
    context: WorkerContext,
    onDrain: () => void,
    private onPullRequestError: (pullRequestReference: PullRequestReference, error: any) => void
  ) {
    this.context = context
    this.waitQueue = new WaitQueue<number>(
      (pullRequestNumber: number) => `${pullRequestNumber}`,
      this.handlePullRequestNumber.bind(this),
      () => {
        // A pull request polling on a timer still belongs to this worker.
        // Draining now would deregister the worker while the timer keeps a
        // reference to its queue, and the next webhook would create a second
        // worker for the same repository - two queues processing one
        // repository concurrently.
        if (this.pollTimers.size === 0) {
          onDrain()
        }
      }
    )
  }

  private schedulePoll (pullRequestNumber: number, delay: number) {
    this.cancelPoll(pullRequestNumber)
    const timer = setTimeout(() => {
      this.pollTimers.delete(pullRequestNumber)
      this.waitQueue.queueLast(pullRequestNumber)
    }, delay)
    this.pollTimers.set(pullRequestNumber, timer)
  }

  private cancelPoll (pullRequestNumber: number) {
    const timer = this.pollTimers.get(pullRequestNumber)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pollTimers.delete(pullRequestNumber)
    }
  }

  private async handlePullRequestNumber (pullRequestNumber: number): Promise<void> {
    const log = this.context.log.child({
      options: {
        pullRequest: pullRequestNumber
      }
    })
    const pullRequestReference = {
      ...this.repository,
      number: pullRequestNumber
    }
    const pullRequestContext: PullRequestContext = {
      github: await this.context.createGitHubAPI(),
      log,
      config: this.context.config,
      reschedulePullRequest: (delay: number = 60 * 1000, position: QueuePosition = 'back') => {
        // 'front' camps the pull request at the head of the queue until its
        // checks report - required when the base branch demands up-to-date
        // branches, where merging serially is the only way to avoid every
        // merge invalidating every other pull request's in-flight checks.
        // 'back' waits on a timer outside the queue: the queue then only
        // ever holds real work, so a waiting pull request costs the other
        // pull requests no queue time at all - a wait task in the queue
        // would block everything behind it for its full delay, and dozens
        // of waiting pull requests would serialize into dead laps. Keeping
        // the pull request out of the queue while it waits also means an
        // event arriving mid-wait is not deduplicated away: it cancels the
        // poll and evaluates immediately (see queue()).
        if (position === 'front') {
          this.waitQueue.queueFirst(pullRequestNumber, delay)
        } else {
          this.schedulePoll(pullRequestNumber, delay)
        }
      },
      startedAt: new Date()
    }
    await Raven.context({
      extra: { pullRequestReference }
    }, async () => {
      try {
        await handlePullRequest(pullRequestContext, pullRequestReference)
      } catch (err) {
        this.onPullRequestError(pullRequestReference, err)
      }
    })
  }

  public queue (pullRequestNumber: number) {
    // An event carries fresher state than the pending poll would see, so the
    // poll is cancelled and the pull request evaluated now instead.
    this.cancelPoll(pullRequestNumber)
    this.waitQueue.stopWaitingFor(pullRequestNumber)
    this.waitQueue.queue(pullRequestNumber)
    this.context.log.debug(`Queued ${pullRequestNumber}`, {
      current: this.waitQueue.currentTask(),
      queued: this.waitQueue.getQueuedTasks()
    })
  }
}

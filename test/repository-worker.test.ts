import { RepositoryWorker } from '../src/repository-worker'
import { handlePullRequest, QueuePosition } from '../src/pull-request-handler'
import { WorkerContext } from '../src/models'
import { immediate } from '../src/delay'
import { createEmptyLogger, createConfig } from './mock'

jest.useFakeTimers()
jest.mock('../src/pull-request-handler')

const handlePullRequestMock = handlePullRequest as jest.Mock

function createWorkerContext (): WorkerContext {
  return {
    createGitHubAPI: async () => ({} as any),
    log: createEmptyLogger(),
    config: createConfig()
  }
}

async function flush () {
  for (let i = 0; i < 10; i++) {
    await immediate()
  }
}

function createWorker (onDrain: () => void = () => undefined): RepositoryWorker {
  return new RepositoryWorker(
    { owner: 'zillyinc', repo: 'zilly-backend' },
    createWorkerContext(),
    onDrain,
    () => undefined
  )
}

function rescheduleOnceThenRecord (handled: number[], rescheduledNumber: number, position: QueuePosition) {
  let rescheduled = false
  handlePullRequestMock.mockImplementation(async (context: any, reference: any) => {
    handled.push(reference.number)
    if (reference.number === rescheduledNumber && !rescheduled) {
      rescheduled = true
      context.reschedulePullRequest(1000, position)
    }
  })
}

describe('RepositoryWorker', () => {
  beforeEach(() => {
    handlePullRequestMock.mockReset()
  })

  it('handles other queued pull requests before a back-rescheduled one gets its next turn', async () => {
    const handled: number[] = []
    rescheduleOnceThenRecord(handled, 1, 'back')

    const worker = createWorker()
    worker.queue(1)
    worker.queue(2)
    await flush()

    // Pull request 2 must not starve behind pull request 1's reschedule delay.
    expect(handled).toEqual([1, 2])

    jest.advanceTimersByTime(1000)
    await flush()

    expect(handled).toEqual([1, 2, 1])
  })

  it('evaluates a waiting pull request immediately when an event arrives mid-poll', async () => {
    const handled: number[] = []
    rescheduleOnceThenRecord(handled, 1, 'back')

    const worker = createWorker()
    worker.queue(1)
    await flush()
    expect(handled).toEqual([1])

    // A check completed on GitHub: the poll is cancelled and the pull
    // request evaluated now, not at the next poll interval.
    worker.queue(1)
    await flush()
    expect(handled).toEqual([1, 1])

    // The cancelled poll must not fire a third evaluation later.
    jest.advanceTimersByTime(1000)
    await flush()
    expect(handled).toEqual([1, 1])
  })

  it('defers draining while a pull request is waiting on a poll', async () => {
    const handled: number[] = []
    rescheduleOnceThenRecord(handled, 1, 'back')
    const onDrain = jest.fn(() => undefined)

    const worker = createWorker(onDrain)
    worker.queue(1)
    await flush()

    // The queue is empty but the poll timer still references this worker;
    // draining now would let a second worker spawn for the same repository.
    expect(handled).toEqual([1])
    expect(onDrain).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1000)
    await flush()

    expect(handled).toEqual([1, 1])
    expect(onDrain).toHaveBeenCalled()
  })

  it('camps a front-rescheduled pull request at the head of the queue', async () => {
    const handled: number[] = []
    rescheduleOnceThenRecord(handled, 1, 'front')

    const worker = createWorker()
    worker.queue(1)
    worker.queue(2)
    await flush()

    // The queue head keeps its place through the delay; nothing else runs.
    expect(handled).toEqual([1])

    jest.advanceTimersByTime(1000)
    await flush()

    expect(handled).toEqual([1, 1, 2])
  })
})

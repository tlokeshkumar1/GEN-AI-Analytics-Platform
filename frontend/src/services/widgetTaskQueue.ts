// Share a small request pool across card reviews and multi-destination publication.
const queued: Array<() => void> = [];
let active = 0;
const concurrency = 4;

function drain() {
  while (active < concurrency && queued.length) {
    active += 1;
    queued.shift()!();
  }
}

export function runWidgetTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queued.push(() => {
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    });
    drain();
  });
}

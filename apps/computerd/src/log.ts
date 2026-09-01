/**
 * The daemon's only output channel. Whoever runs the container reads its state
 * changes with `docker logs`, so stdout is the log - one timestamped line per
 * event, no levels and no dependencies.
 */
export const log = (message: string): void => {
  console.log(`${new Date().toISOString()} computerd ${message}`);
};

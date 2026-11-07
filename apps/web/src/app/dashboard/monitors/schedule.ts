/** `5 minutes`, `1 hour`, `2 days`: the largest whole unit. */
export function span(minutes: number) {
  const [count, unit] =
    minutes % 1440 === 0
      ? [minutes / 1440, "day"]
      : minutes % 60 === 0
        ? [minutes / 60, "hour"]
        : [minutes, "minute"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** `hour`, `5 minutes`: how often, after "every". */
export const interval = (minutes: number) => span(minutes).replace(/^1 /, "");

/** `every hour`, `every 5 minutes`. */
export const every = (minutes: number) => `every ${interval(minutes)}`;

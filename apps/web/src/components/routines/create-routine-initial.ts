export interface RoutineInitial {
  cron: string;
  name: string;
  prompt: string;
  timezone: string;
}

export interface RoutineInitialState {
  customCron: string;
  kind: "daily" | "custom";
  name: string;
  prompt: string;
  timezone: string;
}

/** The first-render state of the create routine form, prefilled when a drafted job is given. */
export const initialRoutineState = (
  initial: RoutineInitial | undefined
): RoutineInitialState => {
  if (initial === undefined) {
    return {
      customCron: "",
      kind: "daily",
      name: "",
      prompt: "",
      timezone: "",
    };
  }
  return {
    customCron: initial.cron,
    kind: "custom",
    name: initial.name,
    prompt: initial.prompt,
    timezone: initial.timezone,
  };
};

import type { IncidentStatus } from "@galena/contracts";

// The update templates people start from; autopilot drafts use them too. Placeholders a person
// must fill stay in braces, and the update is refused until they are replaced.
const TEMPLATES: Record<IncidentStatus, string> = {
  investigating:
    "We're seeing {symptom} on {component} from {regions}. We're investigating and will update by {nextUpdate}.",
  identified: "We found the cause: {cause}. We're {action}. Next update by {nextUpdate}.",
  monitoring:
    "{Component} is working normally again. We're watching it for the next {stableMinutes} minutes.",
  resolved: "{Component} has worked normally since {time}. {Summary}.",
  postmortem: "",
};

/**
 * The template for `status` with the values given. `{Component}` takes `component` with its
 * first letter capitalised, for the start of a sentence.
 */
export function fillTemplate(status: IncidentStatus, values: Readonly<Record<string, string>>) {
  return TEMPLATES[status].replace(/\{([a-z]+)\}/gi, (placeholder, name: string) => {
    const value = values[name] ?? values[name.charAt(0).toLowerCase() + name.slice(1)];
    if (value === undefined) return placeholder;
    return name.charAt(0) === name.charAt(0).toUpperCase()
      ? value.charAt(0).toUpperCase() + value.slice(1)
      : value;
  });
}

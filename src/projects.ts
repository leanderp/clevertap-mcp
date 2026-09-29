import { CleverTapToolError } from "./errors.js";

export interface ProjectResolution<T> {
  name: string;
  client: T;
  /** Set when the requested name was not used as given. */
  note?: string;
}

/**
 * Picks the project a tool call runs against.
 *
 * The catalog of a shared connector is published from ONE discovery credential, so a
 * schema that enumerated project names would tell users of every other profile to send
 * a name that is not theirs (the server then rejected the call). The parameter is a free
 * string instead: a name that matches is used; a name that does not is replaced by the
 * only project when there is exactly one, and is an error, listing the valid names,
 * when there are several.
 */
export function resolveProject<T>(
  clients: Map<string, T>,
  requested: string | undefined,
  defaultName: string
): ProjectResolution<T> {
  const fallback = clients.get(defaultName);
  if (requested === undefined || requested.trim() === "") {
    if (!fallback) throw new CleverTapToolError("No CleverTap project is configured.");
    return { name: defaultName, client: fallback };
  }

  const exact = clients.get(requested);
  if (exact) return { name: requested, client: exact };

  const wanted = requested.trim().toLowerCase();
  for (const [name, client] of clients) {
    if (name.toLowerCase() === wanted) return { name, client };
  }

  const names = Array.from(clients.keys());
  if (clients.size === 1 && fallback) {
    return {
      name: defaultName,
      client: fallback,
      note: `Project "${requested}" is not configured for this account; used "${defaultName}", the only one available.`,
    };
  }
  throw new CleverTapToolError(`Unknown project "${requested}". Available: ${names.join(", ")}.`, {
    hints: ["Omit \"project\" to use the default one, or call clevertap_list_projects to see the configured names."],
  });
}

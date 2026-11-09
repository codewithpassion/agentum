export function RuntimeNotes() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground text-xs">
      <li>
        Isolate agents receive env secrets as placeholders (hm-secret:NAME). The
        platform fills in the real value only in requests to the secret&apos;s
        allowed hosts, so an env secret without allowed hosts does nothing
        there.
      </li>
      <li>
        Isolate agents get proxy secrets added by the platform: the header a
        rule sets is added to requests to the rule&apos;s host, so the script
        leaves it out. Sending the placeholder (hm-secret:NAME) in that header
        works too, and it is refused anywhere else.
      </li>
      <li>
        Machine agents receive env secrets as environment variables of Claude
        Code.
      </li>
      <li>
        Managed agents receive env secrets as placeholders that Anthropic swaps
        for the real value in outgoing requests.
      </li>
      <li>
        Proxy secrets reach machine and managed agents through the relay at
        /api/egress/&lt;host&gt;/&lt;path&gt;. The agent&apos;s instructions
        give the exact address.
      </li>
    </ul>
  );
}

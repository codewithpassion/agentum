export function RuntimeNotes() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground text-xs">
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

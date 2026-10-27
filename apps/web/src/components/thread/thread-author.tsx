/** React escapes display names; no author data is interpreted as markup. */
export function ThreadAuthor({ label }: { label: unknown }) {
  return typeof label === "string" ? (
    <div
      className="text-right text-muted-foreground text-xs"
      data-testid="message-author"
    >
      {label}
    </div>
  ) : null;
}

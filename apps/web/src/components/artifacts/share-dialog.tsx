export interface ShareDialogProps {
  artifactId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function ShareDialog({ artifactId, open }: ShareDialogProps) {
  if (!open) {
    return null;
  }
  return (
    <div data-testid="share-dialog" role="dialog">
      {`Share dialog placeholder: ${artifactId}`}
    </div>
  );
}

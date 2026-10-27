export interface AccessLogProps {
  artifactId: string;
}

export function AccessLog({ artifactId }: AccessLogProps) {
  return (
    <div data-testid="access-log">
      {`Access log placeholder: ${artifactId}`}
    </div>
  );
}

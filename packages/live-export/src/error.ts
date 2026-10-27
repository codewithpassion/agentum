/** Export-specific refusal. Shared-schema admission errors retain their original authority error. */
export class ExportError extends Error {
  readonly code: string;
  readonly path?: string;
  constructor(code: string, path?: string) {
    super(path ? `${code}: ${path}` : code);
    this.name = "ExportError";
    this.code = code;
    this.path = path;
  }
}

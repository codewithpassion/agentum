/** Local uploads bridge the interval before an authoritative manifest arrives. */
export class EditorImagePolicy {
  readonly uploads = new Set<string>();
  private manifest = new Set<string>();

  update(urls: Iterable<string> = []) {
    const next = new Set(urls);
    if (
      next.size !== this.manifest.size ||
      [...next].some((url) => !this.manifest.has(url))
    ) {
      this.uploads.clear();
    }
    this.manifest = next;
    for (const url of next) {
      this.uploads.delete(url);
    }
  }

  get ownBlobUrls() {
    return new Set([...this.manifest, ...this.uploads]);
  }
}

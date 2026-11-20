import { Link } from "@tanstack/react-router";

const NO_FOLDER_TEXT = "This team has no shared folder.";
const FOLDER_HELP = "Every agent in the team can read and write here.";

/** The team's shared folder, opened in the library. */
export function FolderLink({ folderPath }: { folderPath: string | null }) {
  if (folderPath === null) {
    return <p className="text-muted-foreground text-sm">{NO_FOLDER_TEXT}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <Link
        className="font-medium underline-offset-4 hover:underline"
        search={{ dir: folderPath }}
        to="/library"
      >
        {`${folderPath}/`}
      </Link>
      <p className="text-muted-foreground text-sm">{FOLDER_HELP}</p>
    </div>
  );
}

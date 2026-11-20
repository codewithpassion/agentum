import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { FilesTab } from "./index.tsx";

test("Files shows the library and a link to the home folder", () => {
  const props = fixtureTabProps();
  const html = renderInRoom(<FilesTab {...props} />);
  expect(html).toContain("Library");
  expect(html).toContain("<span>agents</span>");
  expect(html).toContain("sorter</span>");
  expect(html).toContain('href="/library?dir=agents%2Fsorter"');
  expect(html).toContain("Open home folder");
});

test("Files leaves out the home folder link when there is no home folder", () => {
  const props = fixtureTabProps();
  const html = renderInRoom(
    <FilesTab
      {...props}
      room={{
        ...props.room,
        profile: { ...props.room.profile, library: { folders: [] } },
      }}
    />
  );
  expect(html).toContain("Library");
  expect(html).not.toContain("Open home folder");
});

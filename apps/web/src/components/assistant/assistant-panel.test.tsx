import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "#/components/ui/tooltip";
import { AssistantConversation } from "./assistant-conversation";
import { assistantHref } from "./assistant-location";

const render = () => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/qa?assistant=new"] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TooltipProvider>
        <AssistantConversation
          admin
          agents={[]}
          hasKey={false}
          initial={null}
          initialList={[]}
        />
      </TooltipProvider>
    </RouterContextProvider>
  );
};

test("opening and switching preserve the page, search parameters and hash", () => {
  expect(assistantHref("/desk?view=board&agent=a#task", "new")).toBe(
    "/desk?view=board&agent=a&assistant=new#task"
  );
  expect(
    assistantHref("/qa?filter=open&assistant=new#question", "chat-1")
  ).toBe("/qa?filter=open&assistant=chat-1#question");
});

test("closing removes only the assistant parameter", () => {
  expect(
    assistantHref("/desk?assistant=chat-1&view=board&agent=a#task", null)
  ).toBe("/desk?view=board&agent=a#task");
});

test("the history column is on the right on desktop with a new conversation control", () => {
  const html = render();
  expect(html).toContain("order-2");
  expect(html).toContain("md:w-[220px] md:border-l");
  expect(html).toContain('aria-label="Conversations"');
  expect(html).toContain('aria-label="New conversation"');
  expect(html).toContain('aria-label="History"');
});

test("the composer keeps the no-key notice and shared disabled dictation button", () => {
  const html = render();
  expect(html).toContain('aria-label="Start dictation"');
  expect(html).toContain('href="/settings/model-providers"');
  expect(html).toContain("Add secret");
  expect(html).toContain("Keep keys out of chat");
});

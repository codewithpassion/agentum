import { Toaster } from "#/components/ui/sonner";
import { useResolvedTheme } from "#/hooks/use-resolved-theme";

// The CLI-generated Toaster reads its theme from next-themes, which this app
// does not use, so on its own it would ignore the theme toggle and follow the
// OS instead. It spreads incoming props last, so passing theme here wins and
// the generated component stays byte-identical to the CLI's output.
export default function ThemedToaster() {
  const theme = useResolvedTheme();

  return <Toaster theme={theme} />;
}

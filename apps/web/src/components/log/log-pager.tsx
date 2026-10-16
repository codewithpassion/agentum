import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";

interface LogPagerProps {
  hasMore: boolean;
  onPageChange: (page: number) => void;
  page: number;
}

export function LogPager({ hasMore, onPageChange, page }: LogPagerProps) {
  const handleNewer = useCallback(() => {
    onPageChange(page - 1);
  }, [onPageChange, page]);

  const handleOlder = useCallback(() => {
    onPageChange(page + 1);
  }, [onPageChange, page]);

  return (
    <div className="flex items-center gap-3">
      <Button
        disabled={page === 0}
        id="log-newer"
        onClick={handleNewer}
        variant="outline"
      >
        Newer
      </Button>
      <span className="text-muted-foreground text-sm">Page {page + 1}</span>
      <Button
        disabled={!hasMore}
        id="log-older"
        onClick={handleOlder}
        variant="outline"
      >
        Older
      </Button>
    </div>
  );
}

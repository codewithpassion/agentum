import Footer from "./footer";
import Header from "./header";

/**
 * Header + footer for the marketing/auth pages. The workspace owns the whole
 * viewport instead, so this is applied per route rather than in `__root`.
 */
export default function SiteChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Header />
      {children}
      <Footer />
    </>
  );
}

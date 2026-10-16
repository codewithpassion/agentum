export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer px-4 pt-10 pb-14 text-muted-foreground">
      <div className="page-wrap">
        <p className="m-0 text-center text-sm sm:text-left">
          &copy; {year} Harbourmaster
        </p>
      </div>
    </footer>
  );
}

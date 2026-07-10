type ErrorPanelProps = {
  title: string;
  message: string;
};

export function ErrorPanel({ title, message }: ErrorPanelProps) {
  return (
    <section className="panel error-panel" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
    </section>
  );
}

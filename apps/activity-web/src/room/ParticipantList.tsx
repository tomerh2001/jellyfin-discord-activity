export type DisplayParticipant = {
  id: string;
  username: string;
  avatar?: string | null;
  isHost?: boolean;
};

type ParticipantListProps = {
  participants: DisplayParticipant[];
};

export function ParticipantList({ participants }: ParticipantListProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Participants</h2>
        <span className="status-pill">{participants.length}</span>
      </div>
      <ul className="participant-list">
        {participants.map((participant) => (
          <li key={participant.id}>
            <span className="avatar" aria-hidden="true">
              {participant.username.slice(0, 1).toUpperCase()}
            </span>
            <span>{participant.username}</span>
            {participant.isHost ? <span className="status-pill">host</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

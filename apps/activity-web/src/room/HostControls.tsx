import { Crown } from "lucide-react";
import { Button } from "../components/Button.js";

type HostControlsProps = {
  canClaimHost: boolean;
  isHost: boolean;
  hostLabel: string;
  onClaimHost: () => void;
};

export function HostControls({ canClaimHost, isHost, hostLabel, onClaimHost }: HostControlsProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Host controls</h2>
        <span className="status-pill">{isHost ? "you host" : "participant"}</span>
      </div>
      <p>{hostLabel}</p>
      <Button icon={<Crown aria-hidden="true" />} disabled={!canClaimHost || isHost} onClick={onClaimHost}>
        Claim host
      </Button>
    </section>
  );
}

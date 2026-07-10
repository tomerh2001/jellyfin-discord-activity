import type { ChangeEvent } from "react";

type SearchBoxProps = {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

export function SearchBox({ value, disabled = false, onChange }: SearchBoxProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value);
  }

  return (
    <label className="search-box">
      <span>Search</span>
      <input
        disabled={disabled}
        onChange={handleChange}
        placeholder={disabled ? "Available to the host after Jellyfin linking" : "Search movies and episodes"}
        value={value}
      />
    </label>
  );
}

import type { Character } from '../core/model';
export default function CharacterAvatar({
  character,
  className = '',
}: {
  character: Character;
  className?: string;
}) {
  return (
    <span className={`character-avatar ${character.color} ${className}`}>
      {character.avatar ? (
        <img src={character.avatar} alt={`${character.name || '角色'}头像`} />
      ) : (
        character.name.slice(0, 1) || '角'
      )}
    </span>
  );
}

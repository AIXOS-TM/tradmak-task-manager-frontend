import type { UserRef } from '../lib/types'
import { initials } from '../utils/format'

interface AvatarProps {
  user?: Pick<UserRef, 'name' | 'avatar_color'> | null
  size?: number
}

export default function Avatar({ user, size = 28 }: AvatarProps) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) }
  if (!user) {
    return (
      <span className="avatar avatar-empty" style={style} title="Unassigned">
        ?
      </span>
    )
  }
  return (
    <span className="avatar" style={{ ...style, background: user.avatar_color }} title={user.name}>
      {initials(user.name)}
    </span>
  )
}

interface AvatarStackProps {
  users: (UserRef | null | undefined)[]
  max?: number
  size?: number
}

export function AvatarStack({ users, max = 4, size = 26 }: AvatarStackProps) {
  const shown = users.slice(0, max)
  const extra = users.length - shown.length
  return (
    <span className="avatar-stack">
      {shown.map((u, i) => (
        <Avatar key={u?.id ?? i} user={u} size={size} />
      ))}
      {extra > 0 && (
        <span className="avatar avatar-more" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
          +{extra}
        </span>
      )}
    </span>
  )
}

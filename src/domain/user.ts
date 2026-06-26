/** An account holder who can create/join leagues and own a Team in each. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

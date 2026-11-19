import {z} from 'zod';

// A receipt locator, not a ticket or a grant. The API rechecks the signed-in owner.
export function runnerReturnId(hash:string):string|null {
  const match=/^#runner-connect=([^&]+)$/.exec(hash);
  const id=z.uuid().safeParse(match?.[1]);
  return id.success?id.data.toLowerCase():null;
}

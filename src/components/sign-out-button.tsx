export function SignOutButton() {
  return (
    <form action="/auth/signout" method="post">
      <button className="btn" type="submit">Sign out</button>
    </form>
  );
}

import { redirect } from 'next/navigation';

export default function ActionPage() {
  async function go() {
    'use server';
    redirect('/');
  }
  return (
    <form action={go}>
      <button type="submit">Run action</button>
    </form>
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { sessionStore } from '../sessionStore';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { publicKey } = body;

    if (!publicKey) {
      return NextResponse.json({ error: 'publicKey is required' }, { status: 400 });
    }

    // Remove session from store
    sessionStore.delete(publicKey);

    return NextResponse.json({ success: true, message: 'Session terminated' }, { status: 200 });
  } catch (error) {
    console.error('Error during logout:', error);
    // Return success even on error (best-effort cleanup)
    return NextResponse.json(
      { success: true, message: 'Session cleanup attempted' },
      { status: 200 },
    );
  }
}

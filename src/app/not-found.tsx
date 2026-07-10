import AppErrorFallback from '@/components/AppErrorFallback';

export default function NotFound() {
  return (
    <AppErrorFallback
      title="This punchlist screen was not found"
      message="The link may be outdated, or this project may no longer be on this device."
    />
  );
}

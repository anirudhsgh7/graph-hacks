import { Suspense } from "react";
import CaseView from "@/components/CaseView";

// Next 16 (cacheComponents): await `params` inside a <Suspense> boundary so the
// static shell can prerender while the route param streams in.
export default function CasePage(props: PageProps<"/case/[id]">) {
  return (
    <Suspense fallback={<CaseSkeleton />}>
      <CaseLoader params={props.params} />
    </Suspense>
  );
}

async function CaseLoader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CaseView caseId={id} />;
}

function CaseSkeleton() {
  return (
    <main className="app-container flex-1 space-y-6 py-6 lg:py-8">
      <div className="border-b border-line pb-5">
        <div className="skeleton h-5 w-56" />
        <div className="skeleton mt-3 h-3 w-2/3" />
      </div>
      <div className="skeleton h-11 w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <div className="skeleton mb-3 h-4 w-40" />
          <div className="skeleton h-[520px] w-full xl:h-[600px]" />
        </div>
        <div className="xl:col-span-5">
          <div className="card space-y-3 p-4">
            <div className="skeleton h-3 w-1/2" />
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-14 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}

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
    <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-4 px-4 py-6 lg:px-6">
      <div className="card">
        <div className="skeleton h-5 w-56" />
        <div className="skeleton mt-3 h-3 w-2/3" />
      </div>
      <div className="card">
        <div className="skeleton h-10 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="card xl:col-span-7">
          <div className="skeleton h-[520px] w-full" />
        </div>
        <div className="card xl:col-span-5">
          <div className="skeleton h-40 w-full" />
        </div>
      </div>
    </main>
  );
}

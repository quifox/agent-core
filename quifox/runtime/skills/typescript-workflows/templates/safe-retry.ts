// Retry only retrieval. Do not reuse this template for writes, payments or external mutations.
/** @phase Retrieval with retry */
async function retrieve() {
    const research = agent("ReadOnlyResearch", {plugins: ["ragflow"], tools: ["knowledge_retrieve"], system: "Use knowledge_retrieve. Return evidence and source names."});
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await research.ask(String(args.question));
        } catch (error) {
            if (attempt === 2) throw error;
            log("Retrying a read-only retrieval step.");
        }
    }
    throw new Error("Retrieval did not complete.");
}
/** @phase Answer */
async function answer(evidence: string) {
    return await agent("Answer", {system: "Answer in Markdown using the supplied evidence; cite sources."})
        .ask(JSON.stringify({question: args.question, evidence, messages: args.messages}));
}
return await answer(await retrieve());

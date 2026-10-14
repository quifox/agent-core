/** @phase Query */
async function query() {
    return await agent("Query", {system: "Rewrite the current knowledge question using conversation history. Return a self-contained query."})
        .ask(JSON.stringify({question: args.question, messages: args.messages}));
}

/** @phase Parallel evidence */
async function evidence(question: string) {
    const [facts, counterEvidence] = await Promise.all([
        agent("Facts", {plugins: ["knowledge"], system: "Use knowledge_retrieve to find direct evidence, citing document names. Identify synthetic Mock evidence explicitly."}).ask(question),
        agent("Check", {plugins: ["knowledge"], system: "Use knowledge_retrieve to find conflicting evidence, scope limitations and missing facts. Identify synthetic Mock evidence explicitly."}).ask(question)
    ]);
    return {facts, counterEvidence};
}

/** @phase Synthesis */
async function synthesize(question: string, sources: {facts: string; counterEvidence: string}) {
    return await agent("Synthesis", {system: "Answer in Markdown from supplied evidence; cite document names and identify conflicts. Identify synthetic Mock evidence explicitly. Do not invent missing evidence."})
        .ask(JSON.stringify({question, sources, messages: args.messages}));
}

const question = await query();
return await synthesize(question, await evidence(question));

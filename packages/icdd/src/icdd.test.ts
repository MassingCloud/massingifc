import { createTestHarness } from "@massingifc/plugin-sdk";
import { describe, expect, it } from "vitest";
import { MemoryArchive, encodeText } from "./archive.js";
import {
  buildIndexGraph,
  buildLinksetGraph,
  readContainer,
  writeContainer,
  type IcddContainer,
} from "./container.js";
import { CT, DEFAULT_PREFIXES, ELS, LINK_TYPES, LS, NS, ONTOLOGY_IRI } from "./ontology.js";
import { createIcddPlugin, ICDD_COMMANDS, IcddToken, invertLink } from "./plugin.js";
import { Graph, literal, namedNode, parseRdfXml, serializeRdfXml } from "./rdf.js";
import { validateContainer } from "./validation.js";
import { parseXml } from "./xml.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const container: IcddContainer = {
  description: {
    id: "container",
    name: "Bridge inspection package",
    description: "Visual inspection delivery",
    conformanceIndicator: "ICDD-Part1-Container",
    creationDate: "2026-07-01T00:00:00Z",
    versionID: "1",
  },
  parties: [{ id: "party-1", kind: "Organisation", name: "MassingCloud" }],
  documents: [
    {
      id: "doc-model",
      kind: "internal",
      name: "Bridge model",
      filename: "bridge.ifc",
      filetype: "ifc",
      format: "application/x-step",
    },
    {
      id: "doc-report",
      kind: "internal",
      name: "Inspection report",
      filename: "reports/inspection.pdf",
      filetype: "pdf",
    },
    {
      id: "doc-spec",
      kind: "external",
      name: "Maintenance standard",
      url: "https://example.org/standards/maintenance",
    },
  ],
  linksets: [
    {
      id: "ls-1",
      name: "Inspection links",
      filename: "inspection.rdf",
      links: [
        {
          id: "link-1",
          type: "Elaborates",
          // The report elaborates one specific wall inside the IFC model, not the whole file.
          from: [{ documentId: "doc-report" }],
          to: [
            {
              documentId: "doc-model",
              identifier: { kind: "string", value: "2O2Fr$t4X7Zf8NOew3FLOH", field: "GlobalId" },
            },
          ],
        },
        {
          id: "link-2",
          type: "IsIdenticalTo",
          elements: [{ documentId: "doc-spec" }, { documentId: "doc-report" }],
        },
      ],
    },
  ],
};

const fullArchive = async (): Promise<MemoryArchive> => {
  const archive = new MemoryArchive();
  await writeContainer(archive, container);
  await archive.write("Payload documents/bridge.ifc", encodeText("ISO-10303-21;"));
  await archive.write("Payload documents/reports/inspection.pdf", encodeText("%PDF-1.7"));
  return archive;
};

// ---------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------

describe("XML parsing", () => {
  it("parses elements, attributes and namespaces", () => {
    const root = parseXml(
      `<?xml version="1.0"?><r:root xmlns:r="http://r/" xmlns="http://d/"><child a="1"/><plain/></r:root>`,
    );

    expect(root.namespace).toBe("http://r/");
    expect(root.localName).toBe("root");
    expect(root.children).toHaveLength(2);
    // An unprefixed element takes the default namespace...
    expect(root.children[1]?.namespace).toBe("http://d/");
    // ...but an unprefixed attribute is in no namespace, which is a real and easily-missed rule.
    expect(root.children[0]?.attributes.get("a")).toBe("1");
  });

  it("decodes entities in text and attributes", () => {
    const root = parseXml(`<r a="a &amp; b">x &lt; y &#65;</r>`);

    expect(root.attributes.get("a")).toBe("a & b");
    expect(root.text).toBe("x < y A");
  });

  it("reads CDATA literally", () => {
    const root = parseXml(`<r><![CDATA[a & b < c]]></r>`);
    expect(root.text).toBe("a & b < c");
  });

  it("skips comments", () => {
    const root = parseXml(`<r><!-- note --><c/></r>`);
    expect(root.children).toHaveLength(1);
  });

  it("rejects an undeclared prefix rather than guessing", () => {
    expect(() => parseXml(`<a:root/>`)).toThrowError(/Undeclared namespace prefix/);
  });

  it("rejects mismatched tags", () => {
    expect(() => parseXml(`<a><b></a></b>`)).toThrowError();
  });

  it("rejects a DTD instead of ignoring it", () => {
    expect(() => parseXml(`<!DOCTYPE r><r/>`)).toThrowError(/not supported/);
  });
});

// ---------------------------------------------------------------------------------------------
// RDF
// ---------------------------------------------------------------------------------------------

describe("RDF graph", () => {
  it("de-duplicates identical triples", () => {
    const graph = new Graph();
    graph.add(namedNode("s"), "p", literal("o"));
    graph.add(namedNode("s"), "p", literal("o"));

    expect(graph.size).toBe(1);
  });

  it("distinguishes literals by datatype", () => {
    const graph = new Graph();
    graph.add(namedNode("s"), "p", literal("1"));
    graph.add(namedNode("s"), "p", literal("1", { datatype: `${NS.xsd}integer` }));

    expect(graph.size).toBe(2);
  });

  it("indexes by subject and finds typed subjects", () => {
    const graph = new Graph();
    graph.add(namedNode("s1"), `${NS.rdf}type`, namedNode(CT.InternalDocument));
    graph.add(namedNode("s2"), `${NS.rdf}type`, namedNode(CT.ExternalDocument));

    expect(graph.subjectsOfType(CT.InternalDocument).map((s) => s.value)).toEqual(["s1"]);
  });
});

describe("RDF/XML round trip", () => {
  it("preserves resources, literals, datatypes and languages", () => {
    const graph = new Graph();
    const subject = namedNode("urn:test#a");
    graph.add(subject, `${NS.rdf}type`, namedNode(CT.InternalDocument));
    graph.add(subject, CT.name, literal("Model"));
    graph.add(subject, CT.filename, literal("m.ifc"));
    graph.add(subject, CT.belongsToContainer, namedNode("urn:test#c"));
    graph.add(subject, CT.description, literal("Modèle", { language: "fr" }));
    graph.add(subject, CT.versionID, literal("2", { datatype: `${NS.xsd}integer` }));

    const round = parseRdfXml(serializeRdfXml(graph));

    expect(round.size).toBe(graph.size);
    expect(round.literal(subject, CT.name)).toBe("Model");
    expect(round.iri(subject, CT.belongsToContainer)).toBe("urn:test#c");
    const description = round.object(subject, CT.description);
    expect(description?.termType === "Literal" && description.language).toBe("fr");
    const version = round.object(subject, CT.versionID);
    expect(version?.termType === "Literal" && version.datatype).toBe(`${NS.xsd}integer`);
  });

  it("escapes characters that would otherwise break the document", () => {
    const graph = new Graph();
    graph.add(namedNode("urn:t#a"), CT.name, literal(`Ampersand & <angle> "quote"`));

    const round = parseRdfXml(serializeRdfXml(graph));
    expect(round.literal("urn:t#a", CT.name)).toBe(`Ampersand & <angle> "quote"`);
  });

  it("writes a typed node element rather than rdf:Description when a type is known", () => {
    const graph = new Graph();
    graph.add(namedNode("urn:t#a"), `${NS.rdf}type`, namedNode(CT.Linkset));

    expect(serializeRdfXml(graph, { prefixes: DEFAULT_PREFIXES })).toContain("<ct:Linkset");
    // With no prefix map the writer still emits valid RDF, using a generated prefix.
    expect(parseRdfXml(serializeRdfXml(graph)).types("urn:t#a")).toEqual([CT.Linkset]);
  });

  it("mints a prefix for an unmapped namespace instead of failing", () => {
    const graph = new Graph();
    graph.add(namedNode("urn:t#a"), "http://custom.example/v#prop", literal("x"));

    const xml = serializeRdfXml(graph);
    expect(parseRdfXml(xml).literal("urn:t#a", "http://custom.example/v#prop")).toBe("x");
  });

  it("rejects a non-RDF root", () => {
    expect(() => parseRdfXml(`<notrdf/>`)).toThrowError(/rdf:RDF/);
  });

  it("refuses rdf:parseType rather than dropping data", () => {
    const xml = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:ct="${NS.ct}"><rdf:Description rdf:about="urn:a"><ct:name rdf:parseType="Literal">x</ct:name></rdf:Description></rdf:RDF>`;
    expect(() => parseRdfXml(xml)).toThrowError(/parseType/);
  });

  it("resolves rdf:ID and relative rdf:about against a base", () => {
    const xml = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:ct="${NS.ct}"><rdf:Description rdf:ID="a"><ct:name>x</ct:name></rdf:Description></rdf:RDF>`;
    const graph = parseRdfXml(xml, { base: "urn:base" });

    expect(graph.literal("urn:base#a", CT.name)).toBe("x");
  });
});

// ---------------------------------------------------------------------------------------------
// Ontology
// ---------------------------------------------------------------------------------------------

describe("ISO 21597 vocabulary", () => {
  it("uses the published Part 1 namespaces", () => {
    expect(NS.ct).toBe("https://standards.iso.org/iso/21597/-1/ed-1/en/Container#");
    expect(NS.ls).toBe("https://standards.iso.org/iso/21597/-1/ed-1/en/Linkset#");
  });

  it("uses the published Part 2 namespace", () => {
    expect(NS.els).toBe("https://standards.iso.org/iso/21597/-2/ed-1/en/ExtendedLinkset#");
  });

  it("defines all fifteen Part 2 link classes", () => {
    expect(Object.keys(ELS)).toHaveLength(15);
    expect(Object.keys(LINK_TYPES)).toHaveLength(15);
  });

  it("covers the nine semantic families", () => {
    const families = new Set(Object.values(LINK_TYPES).map((d) => d.family));
    expect(families).toEqual(
      new Set([
        "Identity",
        "Conflict",
        "Alternative",
        "Specialization",
        "Aggregation",
        "Membership",
        "Replacement",
        "Elaboration",
        "Control",
      ]),
    );
  });

  it("pairs every directed link type with its inverse, symmetrically", () => {
    for (const descriptor of Object.values(LINK_TYPES)) {
      if (!descriptor.directed) {
        expect(descriptor.inverse).toBeUndefined();
        continue;
      }
      const inverse = LINK_TYPES[descriptor.inverse!];
      expect(inverse.inverse).toBe(descriptor.name);
      expect(inverse.family).toBe(descriptor.family);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Container assembly
// ---------------------------------------------------------------------------------------------

describe("container index", () => {
  it("declares the container description and imports the container ontology", () => {
    const graph = buildIndexGraph(container);
    const subject = graph.subjectsOfType(CT.ContainerDescription)[0];

    expect(subject).toBeDefined();
    expect(graph.iri(subject!, `${NS.owl}imports`)).toBe(ONTOLOGY_IRI.container);
    expect(graph.literal(subject!, CT.conformanceIndicator)).toBe("ICDD-Part1-Container");
  });

  it("types documents by their kind and links them to the container both ways", () => {
    const graph = buildIndexGraph(container);

    expect(graph.subjectsOfType(CT.InternalDocument)).toHaveLength(2);
    expect(graph.subjectsOfType(CT.ExternalDocument)).toHaveLength(1);

    const description = graph.subjectsOfType(CT.ContainerDescription)[0]!;
    expect(graph.objects(description, CT.containsDocument)).toHaveLength(3);
    // The inverse assertion is what lets a document be understood on its own.
    expect(graph.iri("urn:icdd:container#doc-model", CT.belongsToContainer)).toBe(
      description.value,
    );
  });

  it("registers linksets separately from documents", () => {
    const graph = buildIndexGraph(container);
    const linkset = graph.subjectsOfType(CT.Linkset)[0];

    expect(graph.literal(linkset!, CT.filename)).toBe("inspection.rdf");
  });

  it("honours a caller-supplied base IRI", () => {
    const graph = buildIndexGraph(container, { baseIri: "https://example.org/c#" });
    expect(graph.subjectsOfType(CT.ContainerDescription)[0]?.value).toBe(
      "https://example.org/c#container",
    );
  });
});

describe("linkset documents", () => {
  const linkset = container.linksets[0]!;

  it("imports the extended linkset ontology only when Part 2 types are used", () => {
    const withExtended = buildLinksetGraph(linkset, { containerId: "container" });
    const imports = withExtended
      .objects("urn:icdd:container#ls-1", `${NS.owl}imports`)
      .map((t) => t.value);
    expect(imports).toContain(ONTOLOGY_IRI.extendedLinkset);

    const plain = buildLinksetGraph(
      { id: "ls-2", name: "Plain", filename: "p.rdf", links: [{ type: "BinaryLink", elements: [{ documentId: "doc-model" }] }] },
      { containerId: "container" },
    );
    expect(
      plain.objects("urn:icdd:container#ls-2", `${NS.owl}imports`).map((t) => t.value),
    ).not.toContain(ONTOLOGY_IRI.extendedLinkset);
  });

  it("writes a directed link with from and to elements", () => {
    const graph = buildLinksetGraph(linkset, { containerId: "container" });
    const subject = graph.subjectsOfType(ELS.Elaborates)[0];

    expect(subject).toBeDefined();
    expect(graph.objects(subject!, LS.hasFromLinkElement)).toHaveLength(1);
    expect(graph.objects(subject!, LS.hasToLinkElement)).toHaveLength(1);
  });

  it("writes a symmetric link with plain link elements", () => {
    const graph = buildLinksetGraph(linkset, { containerId: "container" });
    const subject = graph.subjectsOfType(ELS.IsIdenticalTo)[0];

    expect(graph.objects(subject!, LS.hasLinkElement)).toHaveLength(2);
  });

  it("expresses an element-level identifier", () => {
    const graph = buildLinksetGraph(linkset, { containerId: "container" });
    const identifier = graph.subjectsOfType(LS.StringBasedIdentifier)[0];

    // The whole point of ICDD over a zip: addressing inside a document.
    expect(graph.literal(identifier!, LS.identifier)).toBe("2O2Fr$t4X7Zf8NOew3FLOH");
    expect(graph.literal(identifier!, LS.identifierField)).toBe("GlobalId");
  });

  it("supports URI and query based identifiers", () => {
    const graph = buildLinksetGraph(
      {
        id: "ls-q",
        name: "Q",
        filename: "q.rdf",
        links: [
          {
            type: "BinaryLink",
            elements: [
              { documentId: "doc-model", identifier: { kind: "uri", uri: "https://example.org/e/1" } },
              {
                documentId: "doc-model",
                identifier: { kind: "query", language: "SPARQL", expression: "SELECT ?w WHERE {}" },
              },
            ],
          },
        ],
      },
      { containerId: "container" },
    );

    expect(graph.subjectsOfType(LS.URIBasedIdentifier)).toHaveLength(1);
    expect(graph.subjectsOfType(LS.QueryBasedIdentifier)).toHaveLength(1);
  });
});

describe("container round trip", () => {
  it("writes the canonical ISO 21597 folder layout", async () => {
    const archive = await fullArchive();
    const entries = await archive.entries();

    expect(entries).toContain("index.rdf");
    expect(entries).toContain("Payload triples/inspection.rdf");
    expect(entries).toContain("Payload documents/bridge.ifc");
  });

  it("reads back the description, documents and parties", async () => {
    const read = await readContainer(await fullArchive());

    expect(read.description.name).toBe("Bridge inspection package");
    expect(read.documents).toHaveLength(3);
    expect(read.parties[0]?.name).toBe("MassingCloud");
  });

  it("preserves internal, external and folder document detail", async () => {
    const read = await readContainer(await fullArchive());

    const model = read.documents.find((d) => d.id === "doc-model");
    expect(model?.kind).toBe("internal");
    expect(model?.kind === "internal" && model.filename).toBe("bridge.ifc");

    const spec = read.documents.find((d) => d.id === "doc-spec");
    expect(spec?.kind === "external" && spec.url).toBe("https://example.org/standards/maintenance");
  });

  it("reads links back with their type, direction and element identifiers", async () => {
    const read = await readContainer(await fullArchive());
    const links = read.linksets[0]?.links ?? [];

    const elaborates = links.find((link) => link.type === "Elaborates");
    expect(elaborates).toBeDefined();
    expect(elaborates?.elements.find((e) => e.role === "from")?.documentId).toBe("doc-report");

    const target = elaborates?.elements.find((e) => e.role === "to");
    expect(target?.documentId).toBe("doc-model");
    expect(target?.identifier).toEqual({
      kind: "string",
      value: "2O2Fr$t4X7Zf8NOew3FLOH",
      field: "GlobalId",
    });
  });

  it("does not mistake link elements or identifiers for links", async () => {
    const read = await readContainer(await fullArchive());
    expect(read.linksets[0]?.links).toHaveLength(2);
  });

  it("exposes the parsed graphs so callers can run SPARQL or SHACL themselves", async () => {
    const read = await readContainer(await fullArchive());

    expect(read.indexGraph.size).toBeGreaterThan(0);
    expect(read.linksetGraphs.get("ls-1")?.size).toBeGreaterThan(0);
  });

  it("supports a folder document grouping other documents", async () => {
    const archive = new MemoryArchive();
    await writeContainer(archive, {
      ...container,
      documents: [
        ...container.documents,
        { id: "folder-1", kind: "folder", name: "Reports", foldername: "reports", contains: ["doc-report"] },
      ],
    });
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));
    await archive.write("Payload documents/reports/inspection.pdf", encodeText("x"));

    const read = await readContainer(archive);
    const folder = read.documents.find((d) => d.id === "folder-1");
    expect(folder?.kind === "folder" && folder.contains).toEqual(["doc-report"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

describe("container validation", () => {
  it("passes a well-formed container", async () => {
    const report = await validateContainer(await fullArchive());

    expect(report.conformant).toBe(true);
    expect(report.errors).toBe(0);
  });

  it("reports a missing index", async () => {
    const report = await validateContainer(new MemoryArchive());

    expect(report.conformant).toBe(false);
    expect(report.issues[0]?.code).toBe("missing-index");
  });

  it("reports a declared payload file that was never written", async () => {
    const archive = new MemoryArchive();
    await writeContainer(archive, container);
    // Only one of the two internal documents actually gets its bytes.
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));

    const report = await validateContainer(archive);

    expect(report.conformant).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("payload-file-missing");
  });

  it("warns about a payload file that is present but undeclared", async () => {
    const archive = await fullArchive();
    await archive.write("Payload documents/stray.txt", encodeText("x"));

    const report = await validateContainer(archive);

    expect(report.conformant).toBe(true); // not an error, but invisible to consumers
    expect(report.issues.map((i) => i.code)).toContain("undeclared-payload-file");
  });

  it("reports a link pointing at a document the index does not declare", async () => {
    const archive = new MemoryArchive();
    await writeContainer(archive, {
      ...container,
      linksets: [
        {
          id: "ls-1",
          name: "Broken",
          filename: "broken.rdf",
          links: [{ type: "IsIdenticalTo", elements: [{ documentId: "doc-model" }, { documentId: "ghost" }] }],
        },
      ],
    });
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));
    await archive.write("Payload documents/reports/inspection.pdf", encodeText("x"));

    const report = await validateContainer(archive);

    expect(report.conformant).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("link-references-unknown-document");
  });

  it("reports a directed link that is missing an endpoint", async () => {
    const archive = new MemoryArchive();
    await writeContainer(archive, {
      ...container,
      linksets: [
        {
          id: "ls-1",
          name: "Half",
          filename: "half.rdf",
          links: [{ type: "HasPart", from: [{ documentId: "doc-model" }] }],
        },
      ],
    });
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));
    await archive.write("Payload documents/reports/inspection.pdf", encodeText("x"));

    const report = await validateContainer(archive);
    expect(report.issues.map((i) => i.code)).toContain("directed-link-missing-endpoint");
  });

  it("warns when a symmetric link is given a direction", async () => {
    const archive = new MemoryArchive();
    await writeContainer(archive, {
      ...container,
      linksets: [
        {
          id: "ls-1",
          name: "Odd",
          filename: "odd.rdf",
          links: [
            {
              type: "IsIdenticalTo",
              from: [{ documentId: "doc-model" }],
              to: [{ documentId: "doc-report" }],
            },
          ],
        },
      ],
    });
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));
    await archive.write("Payload documents/reports/inspection.pdf", encodeText("x"));

    const report = await validateContainer(archive);
    expect(report.issues.map((i) => i.code)).toContain("non-directed-link-has-endpoints");
  });

  it("warns when the conformance indicator is absent", async () => {
    const archive = new MemoryArchive();
    const { conformanceIndicator: _drop, ...description } = container.description;
    await writeContainer(archive, { ...container, description });
    await archive.write("Payload documents/bridge.ifc", encodeText("x"));
    await archive.write("Payload documents/reports/inspection.pdf", encodeText("x"));

    const report = await validateContainer(archive);
    expect(report.issues.map((i) => i.code)).toContain("missing-conformance-indicator");
  });
});

// ---------------------------------------------------------------------------------------------
// Link inversion
// ---------------------------------------------------------------------------------------------

describe("link inversion", () => {
  it("swaps both the class and the endpoints", () => {
    const inverted = invertLink({
      id: "l1",
      type: "HasPart",
      from: [{ documentId: "whole" }],
      to: [{ documentId: "part" }],
    });

    // Swapping only endpoints would assert the whole is part of its component.
    expect(inverted?.type).toBe("IsPartOf");
    expect(inverted?.from?.[0]?.documentId).toBe("part");
    expect(inverted?.to?.[0]?.documentId).toBe("whole");
  });

  it("returns undefined for a symmetric link", () => {
    expect(invertLink({ type: "IsIdenticalTo", elements: [{ documentId: "a" }] })).toBeUndefined();
  });

  it("returns undefined for a base linkset class", () => {
    expect(invertLink({ type: "BinaryLink", elements: [{ documentId: "a" }] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------

describe("ICDD plugin", () => {
  it("provides the capability and its commands", async () => {
    const harness = createTestHarness();
    await harness.load(createIcddPlugin());

    expect(harness.kernel.capabilities.has(IcddToken)).toBe(true);
    expect(harness.kernel.commands.has(ICDD_COMMANDS.validateContainer)).toBe(true);

    await harness.dispose();
  });

  it("round-trips a container through commands", async () => {
    const harness = createTestHarness();
    await harness.load(createIcddPlugin());
    const archive = new MemoryArchive();

    const written = await harness.kernel.commands.execute(ICDD_COMMANDS.writeContainer, {
      archive,
      container,
    });
    expect(written.ok).toBe(true);

    const read = await harness.kernel.commands.execute<{ description: { name: string } }>(
      ICDD_COMMANDS.readContainer,
      { archive },
    );
    expect(read.ok && read.value.description.name).toBe("Bridge inspection package");

    await harness.dispose();
  });

  it("reports a malformed container as a failed command, not a crash", async () => {
    const harness = createTestHarness();
    await harness.load(createIcddPlugin());
    const archive = new MemoryArchive({ "index.rdf": "<not-rdf/>" });

    const result = await harness.kernel.commands.execute(ICDD_COMMANDS.readContainer, { archive });

    expect(result.ok).toBe(false);
    expect(harness.kernel.plugins.isActive("massingifc.icdd")).toBe(true);

    await harness.dispose();
  });

  it("exposes all fifteen link types through the capability", async () => {
    const harness = createTestHarness();
    await harness.load(createIcddPlugin());

    const service = harness.kernel.capabilities.require(IcddToken);
    expect(service.ok && service.value.linkTypes()).toHaveLength(15);

    await harness.dispose();
  });
});

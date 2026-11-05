"""Neo4j adapter. Nodes carry a `repo` property so several repos/snapshots can share one database."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict

from neo4j import GraphDatabase

from ..model import DEPENDS_ON, CodeGraph, Impact, Kind, Rel

DEPENDS = "|".join(DEPENDS_ON)


class Neo4jStore:
    def __init__(self, repo: str, uri: str = "bolt://localhost:7687", auth=("neo4j", "airlock-dev")):
        self.repo = repo
        self.driver = GraphDatabase.driver(uri, auth=auth)

    def close(self) -> None:
        self.driver.close()

    def save(self, graph: CodeGraph) -> None:
        nodes: dict[Kind, list[dict]] = defaultdict(list)
        for n in graph.nodes.values():
            nodes[n.kind].append({**asdict(n), "kind": str(n.kind)})
        edges: dict[Rel, list[dict]] = defaultdict(list)
        for e in graph.edges:
            edges[e.rel].append({"src": e.src, "dst": e.dst, "source": e.source})

        with self.driver.session() as s:
            s.run("CREATE CONSTRAINT code_id IF NOT EXISTS FOR (n:Code) REQUIRE (n.repo, n.id) IS UNIQUE")
            s.run("MATCH (n:Code {repo: $repo}) DETACH DELETE n", repo=self.repo)
            # labels and rel types come from our enums, never from input, so interpolation is safe
            for kind, rows in nodes.items():
                s.run(f"UNWIND $rows AS r CREATE (n:Code:{kind}) SET n = r, n.repo = $repo",
                      rows=rows, repo=self.repo)
            for rel, rows in edges.items():
                s.run(f"""UNWIND $rows AS r
                          MATCH (a:Code {{repo: $repo, id: r.src}}), (b:Code {{repo: $repo, id: r.dst}})
                          CREATE (a)-[:{rel} {{source: r.source}}]->(b)""", rows=rows, repo=self.repo)

    def dependents(self, ids: list[str], max_hops: int) -> list[Impact]:
        query = f"""
            MATCH (c:Code {{repo: $repo}}) WHERE c.id IN $ids
            MATCH (d:Code {{repo: $repo}})-[:{DEPENDS}*1..{int(max_hops)}]->(c)
            WHERE NOT d.id IN $ids
            WITH DISTINCT d, c
            MATCH p = shortestPath((d)-[:{DEPENDS}*1..{int(max_hops)}]->(c))
            WITH d, p ORDER BY length(p)
            WITH d, collect(p)[0] AS shortest
            RETURN d.id AS id, length(shortest) AS hops, [n IN nodes(shortest) | n.id] AS path
            ORDER BY hops, id"""
        with self.driver.session() as s:
            return [Impact(r["id"], r["hops"], tuple(r["path"]))
                    for r in s.run(query, repo=self.repo, ids=ids)]

"""Personal file metadata and revision history in the platform document repository."""

import hashlib
import json
import os
import unicodedata
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException
from api.models.execution_context import current_identity
from api.platform.content_store import personal_store


def new_id():
    return uuid4().hex


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def file_name(value):
    name = unicodedata.normalize("NFC", value.strip())
    if not 1 <= len(name) <= 120 or any(ord(c) < 32 or c in "/\\" for c in name):
        raise HTTPException(
            422, "Enter a name of 1–120 characters without path separators or controls."
        )
    return name


class ContentWorkspace:
    def __init__(self, store=None):
        identity = current_identity.get() or {}
        fields = ("tenant_id", "workspace_id", "user_id")
        if not all(identity.get(key) for key in fields):
            raise HTTPException(
                403, "A verified workspace and tenant identity is required."
            )
        self.scope = {key: identity[key] for key in fields}
        self.ns = self.owner_namespace(self.scope["user_id"])
        realm = [self.scope["tenant_id"], self.scope["workspace_id"]]
        self.directory = (
            "files-users:" + hashlib.sha256(json.dumps(realm).encode()).hexdigest()
        )
        self.permission = "owner"
        self.store = store or personal_store()
        if self.store.backend != "hana":
            raise HTTPException(
                503, "My Files requires the SAP HANA Cloud metadata repository."
            )

    def owner_namespace(self, user_id):
        scope = dict(self.scope, user_id=user_id)
        return (
            "files-v1:"
            + hashlib.sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()
        )

    def register(self):
        key = hashlib.sha256(self.scope["user_id"].encode()).hexdigest()
        if not self.store.get(self.directory, key):
            self.store.put(self.directory, key, {"user_id": self.scope["user_id"]})

    def resolve(self, resource_id, write=False):
        index, _ = self.index()
        if resource_id in index:
            return self
        invitation = self.store.get(self.ns + ":shared", resource_id)
        if not invitation:
            raise HTTPException(404, "File is unavailable.")
        owner = ContentWorkspace(self.store)
        owner.ns = self.owner_namespace(invitation["value"]["owner"])
        doc = owner.get(resource_id)
        grant = doc.get("grants", {}).get(self.scope["user_id"])
        if not grant:
            raise HTTPException(404, "File is unavailable.")
        if write and grant != "edit":
            raise HTTPException(403, "Editing permission is required.")
        owner.permission = grant
        return owner

    def share(self, resource_id, recipient, permission, revision):
        with self.store.transaction():
            doc = self.get(resource_id)
            if doc["kind"] != "dashboard" or recipient == self.scope["user_id"]:
                raise HTTPException(
                    422, "Select another workspace user and a dashboard."
                )
            key = hashlib.sha256(recipient.encode()).hexdigest()
            if not self.store.get(self.directory, key):
                raise HTTPException(404, "Workspace user is unavailable.")
            inbox = self.owner_namespace(recipient) + ":shared"
            grants = doc.setdefault("grants", {})
            if permission == "revoke":
                grants.pop(recipient, None)
                self.store.delete(inbox, resource_id)
            else:
                grants[recipient] = permission
                row = self.store.get(inbox, resource_id)
                self.store.put(
                    inbox,
                    resource_id,
                    {"owner": self.scope["user_id"]},
                    row["revision"] if row else 0,
                )
            return self.save(doc, revision, "access")

    def index(self):
        row = self.store.get(self.ns, "index")
        return (row["value"], row["revision"]) if row else ({}, 0)

    @staticmethod
    def ancestors(index, parent):
        chain = []
        while parent is not None:
            node = index.get(parent)
            if node is None or node["kind"] != "folder":
                raise HTTPException(404, "Parent folder is unavailable.")
            if parent in chain:
                raise HTTPException(409, "A folder cannot contain itself.")
            chain.append(parent)
            parent = node["parent_id"]
        return chain

    def hidden(self, index, item):
        return any(
            node["deleted"] or node.get("archived")
            for node in [
                item,
                *(index[i] for i in self.ancestors(index, item["parent_id"])),
            ]
        )

    def tree(self, deleted=False, archived=False):
        index, _ = self.index()
        if deleted:
            visible = [i for i in index.values() if i["deleted"]]
        elif archived:
            visible = [
                i for i in index.values() if i.get("archived") and not i["deleted"]
            ]
        else:
            visible = [i for i in index.values() if not self.hidden(index, i)]
        items = [dict(item, permission="owner") for item in visible]
        if not deleted and not archived:
            for invitation in self.store.list(self.ns + ":shared"):
                try:
                    shared = self.resolve(invitation["id"])
                    doc = shared.get(invitation["id"])
                except HTTPException as exc:
                    if exc.status_code == 404:
                        continue
                    raise
                items.append(
                    {
                        **{
                            k: doc[k]
                            for k in (
                                "id",
                                "kind",
                                "name",
                                "description",
                                "deleted",
                                "revision",
                            )
                        },
                        "parent_id": None,
                        "permission": shared.permission,
                    }
                )
        marks = {r["id"]: r["value"] for r in self.store.list(self.ns + ":bookmarks")}
        return [dict(i, **marks.get(i["id"], {})) for i in items]

    def mark(self, resource_id, *, favourite=None):
        with self.store.transaction():
            self.resolve(resource_id).get(resource_id)
            ns = self.ns + ":bookmarks"
            row = self.store.get(ns, resource_id)
            value = row["value"] if row else {}
            if favourite is None:
                value["last_opened"] = timestamp()
            else:
                value["favourite"] = favourite
            self.store.put(ns, resource_id, value, row["revision"] if row else 0)
            return value

    def get(self, resource_id, include_deleted=False):
        index, _ = self.index()
        item = index.get(resource_id)
        if item is None or (not include_deleted and self.hidden(index, item)):
            raise HTTPException(404, "File is unavailable.")
        doc = self.store.get(self.ns, resource_id)["value"]
        if (
            self.permission != "owner"
            and doc.get("grants", {}).get(self.scope["user_id"]) != self.permission
        ):
            raise HTTPException(404, "File is unavailable.")
        return doc

    def save(self, doc, revision, action):
        index, seq = self.index()
        if (
            doc.get("revision", 0) != revision
            or index.get(doc["id"], {}).get("revision", 0) != revision
        ):
            raise HTTPException(409, "This file changed. Reload and retry.")
        parent = doc["parent_id"]
        chain = self.ancestors(index, parent)
        if any(index[i]["deleted"] or index[i].get("archived") for i in chain):
            raise HTTPException(409, "Restore the parent folder first.")
        if doc["id"] in chain:
            raise HTTPException(409, "Choose a folder outside this subtree.")
        if (
            any(
                i["parent_id"] == parent
                and i["id"] != doc["id"]
                and not i["deleted"]
                and i["name"].casefold() == doc["name"].casefold()
                for i in index.values()
            )
            and not doc["deleted"]
        ):
            raise HTTPException(409, "This folder already contains that name.")
        if not revision and len(index) >= int(os.getenv("CONTENT_FILE_LIMIT", "1000")):
            raise HTTPException(409, "Personal file limit reached.")
        doc.update(
            revision=revision + 1,
            updated_at=timestamp(),
            modified_by=self.scope["user_id"],
        )
        index[doc["id"]] = {
            k: doc[k]
            for k in (
                "id",
                "kind",
                "name",
                "description",
                "parent_id",
                "deleted",
                "archived",
                "revision",
            )
        }
        if not revision or action == "move":
            limit = int(os.getenv("CONTENT_MAX_DEPTH", "16"))
            for item in index.values():
                if len(self.ancestors(index, item["parent_id"])) + 1 > limit:
                    raise HTTPException(409, "Folder depth limit exceeded.")
        self.store.put(self.ns, "index", index, seq)
        self.store.put(self.ns, doc["id"], doc, revision)
        self.store.put(
            self.ns + ":history:" + doc["id"],
            str(doc["revision"]),
            {"action": action, "document": doc},
        )
        return doc

    def create(self, kind, name, description="", parent_id=None):
        with self.store.transaction():
            doc = dict(
                self.scope,
                id=new_id(),
                owner_id=self.scope["user_id"],
                kind=kind,
                name=file_name(name),
                description=description,
                parent_id=parent_id,
                deleted=False,
                archived=False,
                created_at=timestamp(),
                created_by=self.scope["user_id"],
            )
            if kind == "dashboard":
                doc.update(
                    pages=[dict(id=new_id(), name="Overview", widgets=[])],
                    publication_status="draft",
                )
            return self.save(doc, 0, "create")

    def change(self, resource_id, revision, changes):
        with self.store.transaction():
            doc = self.get(
                resource_id,
                include_deleted=changes.get("deleted") is False
                or changes.get("archived") is False,
            )
            if changes.get("name") is not None:
                changes["name"] = file_name(changes["name"])
            doc.update(changes)
            action = "move" if "parent_id" in changes else "edit"
            if "deleted" in changes:
                action = "delete" if changes["deleted"] else "restore"
            elif "archived" in changes:
                action = "archive" if changes["archived"] else "unarchive"
            return self.save(doc, revision, action)

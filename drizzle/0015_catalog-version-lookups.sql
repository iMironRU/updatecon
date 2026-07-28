CREATE INDEX "release_project_versions_version_idx" ON "release_project_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "update_edges_from_version_idx" ON "update_edges" USING btree ("from_version");--> statement-breakpoint
CREATE INDEX "update_edges_to_version_idx" ON "update_edges" USING btree ("to_version");
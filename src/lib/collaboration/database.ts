export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface CollaborationDatabase {
  public: {
    Tables: {
      user_profiles: {
        Row: {
          user_id: string;
          username: string;
          first_name: string;
          last_name: string;
          job_title: string;
          avatar_path: string | null;
          avatar_synced_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          username: string;
          first_name: string;
          last_name: string;
          job_title: string;
          avatar_path?: string | null;
          avatar_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['user_profiles']['Insert']>;
        Relationships: [];
      };
      shared_projects: {
        Row: {
          id: string;
          local_project_id: string | null;
          project_name: string;
          owner_user_id: string;
          created_by_user_id: string;
          join_code_hash: string | null;
          join_code_expires_at: string | null;
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          local_project_id?: string | null;
          project_name: string;
          owner_user_id: string;
          created_by_user_id: string;
          join_code_hash?: string | null;
          join_code_expires_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_projects']['Insert']>;
        Relationships: [];
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          user_id: string | null;
          email: string;
          display_name: string | null;
          access_state: 'invited' | 'active' | 'removed';
          joined_by: 'emailInvite' | 'joinCode';
          invited_by_user_id: string | null;
          invited_at: string;
          joined_at: string | null;
          removed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id?: string | null;
          email: string;
          display_name?: string | null;
          access_state?: 'invited' | 'active' | 'removed';
          joined_by?: 'emailInvite' | 'joinCode';
          invited_by_user_id?: string | null;
          invited_at?: string;
          joined_at?: string | null;
          removed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['project_members']['Insert']>;
        Relationships: [];
      };
      ownership_transfers: {
        Row: {
          id: string;
          project_id: string;
          from_user_id: string;
          to_user_id: string;
          transferred_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          from_user_id: string;
          to_user_id: string;
          transferred_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['ownership_transfers']['Insert']>;
        Relationships: [];
      };
      area_claims: {
        Row: {
          id: string;
          project_id: string;
          area_id: string;
          claimed_by_user_id: string;
          status: 'active' | 'released' | 'transferred' | 'expired';
          claimed_at: string;
          expires_at: string | null;
          released_at: string | null;
          transferred_to_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          area_id: string;
          claimed_by_user_id: string;
          status?: 'active' | 'released' | 'transferred' | 'expired';
          claimed_at?: string;
          expires_at?: string | null;
          released_at?: string | null;
          transferred_to_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['area_claims']['Insert']>;
        Relationships: [];
      };
      collaboration_mutations: {
        Row: {
          id: string;
          project_id: string;
          entity_type: 'project' | 'area' | 'location' | 'item' | 'checkpoint' | 'photoAttachment' | 'fileAttachment';
          entity_id: string;
          parent_entity_id: string | null;
          action: 'create' | 'update' | 'delete' | 'restore' | 'attach' | 'detach';
          patch: Json;
          base_version: number | null;
          author_user_id: string;
          client_id: string;
          status: 'queued' | 'sending' | 'accepted' | 'rejected' | 'conflicted';
          created_at: string;
          sent_at: string | null;
          accepted_at: string | null;
          rejected_at: string | null;
          error_message: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          entity_type: 'project' | 'area' | 'location' | 'item' | 'checkpoint' | 'photoAttachment' | 'fileAttachment';
          entity_id: string;
          parent_entity_id?: string | null;
          action: 'create' | 'update' | 'delete' | 'restore' | 'attach' | 'detach';
          patch?: Json;
          base_version?: number | null;
          author_user_id: string;
          client_id: string;
          status?: 'queued' | 'sending' | 'accepted' | 'rejected' | 'conflicted';
          created_at?: string;
          sent_at?: string | null;
          accepted_at?: string | null;
          rejected_at?: string | null;
          error_message?: string | null;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['collaboration_mutations']['Insert']>;
        Relationships: [];
      };
      shared_attachments: {
        Row: {
          id: string;
          project_id: string;
          area_id: string | null;
          checkpoint_id: string | null;
          uploaded_by_user_id: string;
          storage_bucket: string;
          storage_path: string;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          area_id?: string | null;
          checkpoint_id?: string | null;
          uploaded_by_user_id: string;
          storage_bucket: string;
          storage_path: string;
          file_name: string;
          mime_type: string;
          size_bytes?: number;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_attachments']['Insert']>;
        Relationships: [];
      };
      shared_project_snapshots: {
        Row: {
          project_id: string;
          project_payload: Json;
          payload_version: number;
          published_by_user_id: string;
          published_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          project_id: string;
          project_payload: Json;
          payload_version?: number;
          published_by_user_id: string;
          published_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_project_snapshots']['Insert']>;
        Relationships: [];
      };
      shared_project_metadata_snapshots: {
        Row: {
          project_id: string;
          metadata_payload: Json;
          payload_version: number;
          version: number;
          published_by_user_id: string;
          published_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          project_id: string;
          metadata_payload: Json;
          payload_version?: number;
          version?: number;
          published_by_user_id: string;
          published_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_project_metadata_snapshots']['Insert']>;
        Relationships: [];
      };
      shared_project_area_snapshots: {
        Row: {
          project_id: string;
          area_id: string;
          area_payload: Json;
          payload_version: number;
          version: number;
          published_by_user_id: string;
          published_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          project_id: string;
          area_id: string;
          area_payload: Json;
          payload_version?: number;
          version?: number;
          published_by_user_id: string;
          published_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_project_area_snapshots']['Insert']>;
        Relationships: [];
      };
      shared_project_snapshot_history: {
        Row: {
          id: string;
          project_id: string;
          project_name: string;
          project_payload: Json;
          payload_version: number;
          captured_by_user_id: string;
          captured_at: string;
          reason: 'publish' | 'before_publish' | 'before_pull' | 'manual' | 'restore';
          note: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          project_name?: string;
          project_payload: Json;
          payload_version?: number;
          captured_by_user_id: string;
          captured_at?: string;
          reason?: 'publish' | 'before_publish' | 'before_pull' | 'manual' | 'restore';
          note?: string | null;
        };
        Update: Partial<CollaborationDatabase['public']['Tables']['shared_project_snapshot_history']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_shared_project: {
        Args: {
          p_local_project_id: string;
          p_project_name: string;
          p_owner_email: string;
          p_owner_display_name?: string | null;
        };
        Returns: string;
      };
      generate_shared_project_join_code: {
        Args: {
          p_project_id: string;
        };
        Returns: Json;
      };
      publish_shared_project_snapshot: {
        Args: {
          p_project_id: string;
          p_project_payload: Json;
          p_payload_version?: number;
          p_base_published_at?: string | null;
        };
        Returns: string;
      };
      publish_shared_project_snapshot_v2: {
        Args: {
          p_project_id: string;
          p_project_payload: Json;
          p_payload_version: number;
          p_base_published_at: string | null;
          p_base_metadata_version: number;
        };
        Returns: string;
      };
      publish_shared_project_metadata_snapshot: {
        Args: {
          p_project_id: string;
          p_metadata_payload: Json;
          p_payload_version?: number;
          p_base_version?: number;
          p_client_id: string;
        };
        Returns: {
          metadata_version: number;
          published_at: string;
        }[];
      };
      publish_shared_project_area_snapshot: {
        Args: {
          p_project_id: string;
          p_area_id: string;
          p_area_payload: Json;
          p_payload_version?: number;
          p_base_version?: number;
          p_base_published_at?: string;
          p_client_id: string;
        };
        Returns: {
          area_version: number;
          published_at: string;
        }[];
      };
      capture_shared_project_backup: {
        Args: {
          p_project_id: string;
          p_project_payload: Json;
          p_payload_version?: number;
          p_reason?: 'publish' | 'before_publish' | 'before_pull' | 'manual' | 'restore';
          p_note?: string | null;
        };
        Returns: string;
      };
      list_my_shared_projects: {
        Args: Record<string, never>;
        Returns: {
          project_id: string;
          local_project_id: string;
          project_name: string;
          owner_user_id: string;
          owner_email: string | null;
          joined_at: string | null;
          published_at: string | null;
          updated_at: string;
        }[];
      };
      join_shared_project_by_code: {
        Args: {
          p_join_code: string;
          p_member_email: string;
          p_member_display_name?: string | null;
        };
        Returns: Json;
      };
      claim_shared_project_area: {
        Args: {
          p_project_id: string;
          p_area_id: string;
          p_expires_at: string | null;
        };
        Returns: Json;
      };
      release_shared_project_area: {
        Args: {
          p_project_id: string;
          p_area_id: string;
        };
        Returns: undefined;
      };
      transfer_shared_project_ownership: {
        Args: {
          p_project_id: string;
          p_new_owner_email: string;
        };
        Returns: Json;
      };
      remove_shared_project_member: {
        Args: {
          p_project_id: string;
          p_member_email: string;
        };
        Returns: Json;
      };
      disconnect_shared_project: {
        Args: {
          p_project_id: string;
        };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

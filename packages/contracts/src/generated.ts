/* Generated from contracts/agent-response.schema.json; do not edit. */

export interface FaultlineAgentResponse {
  schema_version: 2;
  revision_id: string;
  input_hash: string;
  stage: "setup" | "measure" | "explain" | "test" | "report" | "follow_up";
  message: string;
  /**
   * @maxItems 20
   */
  evidence_ids:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * @maxItems 5
   */
  memory_capsule_ids:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
  analysis: {
    current_belief: string;
    what_changed: string;
    /**
     * @maxItems 5
     */
    hypotheses:
      | []
      | [
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          }
        ]
      | [
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          }
        ]
      | [
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          }
        ]
      | [
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          }
        ]
      | [
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          },
          {
            title: string;
            statement: string;
            /**
             * @maxItems 10
             */
            supporting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 10
             */
            contradicting_evidence_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string]
              | [string, string, string, string, string, string]
              | [string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string]
              | [string, string, string, string, string, string, string, string, string, string];
            /**
             * @maxItems 5
             */
            memory_capsule_ids:
              | []
              | [string]
              | [string, string]
              | [string, string, string]
              | [string, string, string, string]
              | [string, string, string, string, string];
            falsifier: string;
            confidence: "low" | "medium" | "high";
          }
        ];
    /**
     * @maxItems 10
     */
    unknowns:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string];
  };
  /**
   * @maxItems 5
   */
  actions:
    | []
    | [
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        }
      ]
    | [
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        }
      ]
    | [
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        }
      ]
    | [
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        }
      ]
    | [
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        },
        {
          kind:
            | "open_data"
            | "review_metric"
            | "generate_hypotheses"
            | "open_evidence"
            | "open_data_checks"
            | "open_browser_tests"
            | "draft_report"
            | "open_follow_up"
            | "gather_related_evidence"
            | "recall_prior_investigations"
            | "review_results"
            | "draft_test_plan"
            | "schedule_follow_up";
          title: string;
          reason: string;
          requires_approval: true;
          parameters: {
            template_id?:
              | "release_exposure"
              | "support_symptoms"
              | "change_timeline"
              | "cohort_context"
              | "contrary_evidence"
              | "followup_recheck";
            query?: string;
            release_id?: string;
            affected_cohort?: string;
            control_cohort?: string;
            test_kind?: "data_validation" | "controlled_comparison" | "external_browser";
          };
        }
      ];
  /**
   * @maxItems 5
   */
  questions:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
  /**
   * @maxItems 10
   */
  limitations:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
}

/* Generated from contracts/analytic-plan.schema.json; do not edit. */

export interface FaultlineAnalyticPlan {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  hypothesis_id: string;
  kind: "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control";
  metric_hash: string;
  snapshot_hash: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  evidence_ids: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 8
   */
  cohorts:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  expected_direction: "increase" | "decrease" | "unchanged" | "unknown";
  minimum_denominator: number;
  purpose: string;
}

/* Generated from contracts/approval.schema.json; do not edit. */

export interface FaultlineApproval {
  plan_hash: string;
  oracle_hash: string;
  workspace_id: string;
  reviewer_id: string;
  reviewer_role: "owner" | "analyst";
  grant_hash: string;
  expires_at: string;
  revoked: boolean;
}

/* Generated from contracts/browser-plan.schema.json; do not edit. */

export type FaultlineBrowserPlan = {
  [k: string]: unknown;
} & {
  version: 1;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  hypothesis_id: string;
  objective: "mechanism" | "correction";
  mode: "trusted_fixture" | "verified_staging" | "exploratory";
  policy_version: "checkout_mechanism_v1" | "checkout_completion_v1";
  oracle_hash: string;
  metric_hash: string;
  snapshot_hash: string;
  fixture_hash: string;
  environment_hash: string;
  runner_id: string;
  repeats: 3;
  cohorts: ["mobile", "desktop"];
  /**
   * @minItems 1
   * @maxItems 30
   */
  actions: [
    (
      | {
          op: "navigate";
          path: string;
        }
      | {
          op: "click";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
        }
      | {
          op: "fill";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
          value_ref: string;
        }
      | {
          op: "wait_for";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
          timeout_ms: number;
        }
    ),
    ...(
      | {
          op: "navigate";
          path: string;
        }
      | {
          op: "click";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
        }
      | {
          op: "fill";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
          value_ref: string;
        }
      | {
          op: "wait_for";
          locator: {
            kind: "test_id" | "role" | "label";
            value: string;
            role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
          };
          timeout_ms: number;
        }
    )[]
  ];
  /**
   * @minItems 2
   * @maxItems 3
   */
  arms:
    | [
        {
          arm: "known_good" | "incident" | "candidate";
          origin: string;
          build_digest: string;
          deployment_evidence_hash: string;
        },
        {
          arm: "known_good" | "incident" | "candidate";
          origin: string;
          build_digest: string;
          deployment_evidence_hash: string;
        }
      ]
    | [
        {
          arm: "known_good" | "incident" | "candidate";
          origin: string;
          build_digest: string;
          deployment_evidence_hash: string;
        },
        {
          arm: "known_good" | "incident" | "candidate";
          origin: string;
          build_digest: string;
          deployment_evidence_hash: string;
        },
        {
          arm: "known_good" | "incident" | "candidate";
          origin: string;
          build_digest: string;
          deployment_evidence_hash: string;
        }
      ];
  observation_profile_hash?: string;
};

/* Generated from contracts/build-attestation.schema.json; do not edit. */

export interface FaultlineBuildAttestation {
  schema_version: 1;
  attester_key_id: string;
  body: {
    workspace_id: string;
    case_id: string;
    deployment_id: string;
    build_digest: string;
    commit_sha: string;
    origin: string;
    observed_at: string;
    expires_at: string;
    provenance_evidence_hash: string;
  };
  signature: string;
}

/* Generated from contracts/canonical-event.schema.json; do not edit. */

export interface FaultlineCanonicalEvent {
  source_id: string;
  event_id: string;
  session_id: string;
  event_name: string;
  occurred_at: string;
  device: string;
  excluded: boolean;
  release_id: string | null;
}

/* Generated from contracts/claim.schema.json; do not edit. */

export interface FaultlineClaim {
  association: "not_established" | "observed";
  mechanism: "untested" | "reproduced" | "not_reproduced" | "inconclusive";
  correction: "not_tested" | "validated" | "failed" | "inconclusive";
  attribution: {
    scope: "association_only";
    causal_effect: "not_established";
  };
  freshness: "fresh" | "stale";
  coverage_quality: "complete_attested" | "provisional" | "incomplete";
  scope: "synthetic_fixture" | "specified_snapshot_and_test_environment";
  warning: "LATE_ARRIVAL_ASSUMPTION" | null;
}

/* Generated from contracts/connector-capabilities.schema.json; do not edit. */

export interface FaultlineConnectorCapabilities {
  schema_version: 1;
  source_kind:
    | "posthog_existing_file_export"
    | "github_changes"
    | "local_file"
    | "model"
    | "runner"
    | "zetaris_federated_evidence";
  status: "unconfigured" | "available" | "unavailable" | "unauthorized" | "unsupported";
  checked_at: string;
  adapter_version: string;
  read_only: boolean;
  /**
   * @minItems 0
   * @maxItems 30
   */
  features: string[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  unsupported_features: string[];
  reason_code: string | null;
  provider_version: string | null;
}

/* Generated from contracts/coverage-declaration.schema.json; do not edit. */

export interface FaultlineCoverageDeclaration {
  basis: "operator_attestation" | "lateness_assumption" | "none";
  /**
   * @minItems 0
   * @maxItems 100
   */
  event_time_intervals: {
    start: string;
    end: string;
  }[];
  declared_event_watermark: string | null;
  statement: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  reference_evidence_ids:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  late_arrival_hours: number;
}

/* Generated from contracts/coverage.schema.json; do not edit. */

export interface FaultlineCoverage {
  extraction_status: "complete" | "partial" | "unknown";
  basis: "source_guarantee" | "operator_attestation" | "lateness_assumption" | "none";
  covered_start: string | null;
  covered_end: string | null;
  event_watermark: string | null;
  attestation: string;
  /**
   * @minItems 0
   * @maxItems 100
   */
  event_time_intervals: {
    start: string;
    end: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 20
   */
  received_time_intervals?:
    | []
    | [
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ];
  /**
   * @minItems 0
   * @maxItems 20
   */
  assumptions?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}

/* Generated from contracts/evidence.schema.json; do not edit. */

export interface FaultlineEvidence {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  snapshot_id: string | null;
  source_kind: "analytics" | "support" | "release" | "deployment" | "test" | "human_note" | "federated_query";
  source_ref: string;
  content_hash: string;
  event_time:
    | {
        kind: "exact";
        at: string;
      }
    | {
        kind: "range";
        start: string;
        end: string;
      }
    | {
        kind: "unknown";
        raw_description: string;
      };
  captured_at: string;
  text: string;
  redaction_status: "sanitized" | "restricted" | "withdrawn";
  evidence_status: "observed" | "user_attested" | "inferred" | "unknown";
  supersedes_id: string | null;
  /**
   * @minItems 0
   * @maxItems 20
   */
  artifact_refs:
    | []
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ]
    | [
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        },
        {
          artifact_id: string;
          sha256: string;
          media_type: string;
          size_bytes: number;
          redaction_status: "restricted" | "sanitized" | "withdrawn";
        }
      ];
}

/* Generated from contracts/hypothesis.schema.json; do not edit. */

export interface FaultlineHypothesis {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  title: string;
  statement: string;
  mechanism_description: string;
  status: "proposed" | "accepted" | "rejected" | "needs_evidence";
  /**
   * @minItems 0
   * @maxItems 50
   */
  supporting_evidence_ids: string[];
  /**
   * @minItems 0
   * @maxItems 50
   */
  contradicting_evidence_ids: string[];
  /**
   * @minItems 0
   * @maxItems 20
   */
  missing_evidence:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  falsifier: string;
  /**
   * @minItems 1
   * @maxItems 8
   */
  proposed_test_kinds:
    | [
        | "data_quality"
        | "cohort_change"
        | "mix_shift"
        | "temporal_alignment"
        | "negative_control"
        | "mechanism"
        | "correction"
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ]
    | [
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        ),
        (
          | "data_quality"
          | "cohort_change"
          | "mix_shift"
          | "temporal_alignment"
          | "negative_control"
          | "mechanism"
          | "correction"
        )
      ];
  origin: "human" | "model";
  priority: "low" | "normal" | "high";
}

/* Generated from contracts/job.schema.json; do not edit. */

export interface FaultlineJob {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string | null;
  kind:
    | "import"
    | "capture"
    | "metric"
    | "hypotheses"
    | "analytic_test"
    | "browser_test"
    | "diagnosis"
    | "export"
    | "follow_up"
    | "retention";
  status: "queued" | "running" | "waiting_for_input" | "cancel_requested" | "cancelled" | "succeeded" | "failed";
  progress_completed: number;
  progress_total: number | null;
  input_hash: string;
  attempt: number;
  created_at: string;
  updated_at: string;
  waiting_reason: string | null;
  result_ref: string | null;
  error_code: string | null;
}

/* Generated from contracts/metric-result.schema.json; do not edit. */

export interface FaultlineMetricResult {
  metric_hash: string;
  quality: "complete_attested" | "provisional" | "incomplete";
  basis: "source_guarantee" | "operator_attestation" | "lateness_assumption" | "none";
  baseline: {
    eligible: number;
    converted: number;
    rate: number | null;
    interval: {
      low: number;
      high: number;
      level: 0.95;
      method: "wilson_descriptive";
    } | null;
    strata: {
      /**
       * This interface was referenced by `undefined`'s JSON-Schema definition
       * via the `patternProperty` "^[A-Za-z0-9_-]{1,64}$".
       */
      [k: string]: {
        eligible: number;
        converted: number;
        rate: number | null;
        interval: {
          low: number;
          high: number;
          level: 0.95;
          method: "wilson_descriptive";
        } | null;
      };
    };
    unknown_cohort_count: number;
  } | null;
  comparison: {
    eligible: number;
    converted: number;
    rate: number | null;
    interval: {
      low: number;
      high: number;
      level: 0.95;
      method: "wilson_descriptive";
    } | null;
    strata: {
      /**
       * This interface was referenced by `undefined`'s JSON-Schema definition
       * via the `patternProperty` "^[A-Za-z0-9_-]{1,64}$".
       */
      [k: string]: {
        eligible: number;
        converted: number;
        rate: number | null;
        interval: {
          low: number;
          high: number;
          level: 0.95;
          method: "wilson_descriptive";
        } | null;
      };
    };
    unknown_cohort_count: number;
  } | null;
  delta_pp: number | null;
  relative_change: number | null;
  reason?: string;
}

/* Generated from contracts/metric.schema.json; do not edit. */

export interface FaultlineMetric {
  version: 1;
  template: "session_conversion_v1";
  source_id: string;
  unit: "session";
  entry_event: string;
  success_event: string;
  horizon_seconds: 1800;
  segment_property: "device";
  /**
   * @minItems 1
   * @maxItems 8
   */
  cohorts:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  windows: {
    baseline: {
      start: string;
      end: string;
    };
    comparison: {
      start: string;
      end: string;
    };
  };
  exclusion_rule: "entry_excluded_false";
  timezone: "UTC";
}

/* Generated from contracts/model-response.schema.json; do not edit. */

export interface FaultlineModelResponse {
  schema_version: 1;
  kind: "hypotheses" | "critique" | "diagnosis_draft";
  revision_id: string;
  input_hash: string;
  /**
   * @minItems 0
   * @maxItems 5
   */
  hypotheses:
    | []
    | [
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        }
      ]
    | [
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        }
      ]
    | [
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        }
      ]
    | [
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        }
      ]
    | [
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        },
        {
          title: string;
          statement: string;
          /**
           * @minItems 0
           * @maxItems 20
           */
          supporting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 20
           */
          contradicting_evidence_ids:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string, string, string, string]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ]
            | [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string
              ];
          /**
           * @minItems 0
           * @maxItems 10
           */
          missing_evidence:
            | []
            | [string]
            | [string, string]
            | [string, string, string]
            | [string, string, string, string]
            | [string, string, string, string, string]
            | [string, string, string, string, string, string]
            | [string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string]
            | [string, string, string, string, string, string, string, string, string, string];
          falsifier: string;
          /**
           * @minItems 1
           * @maxItems 5
           */
          proposed_test_kinds:
            | ["data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ]
            | [
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                (
                  | "data_quality"
                  | "cohort_change"
                  | "mix_shift"
                  | "temporal_alignment"
                  | "negative_control"
                  | "mechanism"
                ),
                "data_quality" | "cohort_change" | "mix_shift" | "temporal_alignment" | "negative_control" | "mechanism"
              ];
        }
      ];
  /**
   * @minItems 0
   * @maxItems 30
   */
  draft_sentences: {
    text: string;
    /**
     * @minItems 0
     * @maxItems 20
     */
    evidence_ids:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
    qualification: "observed" | "hypothesis" | "limitation" | "next_step";
  }[];
  /**
   * @minItems 0
   * @maxItems 10
   */
  questions:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  /**
   * @minItems 0
   * @maxItems 20
   */
  limitations:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}

/* Generated from contracts/observation-profile.schema.json; do not edit. */

export interface FaultlineObservationProfile {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  template: "checkout_receipt_v1";
  success_locator: {
    kind: "test_id" | "role" | "label";
    value: string;
    role?: "button" | "textbox" | "checkbox" | "link" | "combobox";
  };
  receipt: {
    path_template: string;
    method: "GET";
    credential_ref: string | null;
    completed_pointer: string;
    order_count_pointer: string;
    error_code_pointer: string | null;
    max_response_bytes: number;
  };
  incident_error_code: string | null;
  /**
   * @minItems 1
   * @maxItems 20
   */
  symptom_evidence_ids:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  sandbox_only: true;
  created_at: string;
  reviewed_by: string;
  profile_hash: string;
}

/* Generated from contracts/observation.schema.json; do not edit. */

export interface FaultlineObservation {
  arm: "known_good" | "incident" | "candidate";
  cohort: "mobile" | "desktop";
  repeat: number;
  status: "observed" | "blocked" | "failed" | "cancelled";
  plan_hash: string;
  oracle_hash: string;
  build_digest: string;
  build_digest_after: string;
  deployment_evidence_hash: string;
  fixture_hash: string;
  environment_hash: string;
  runner_id: string;
  actual: {
    checkout_completed: boolean;
    order_created_count: number;
    error_code: string | null;
  } | null;
}

/* Generated from contracts/oracle.schema.json; do not edit. */

export interface FaultlineOracle {
  version: "checkout_mechanism_v1" | "checkout_completion_v1";
  /**
   * @minItems 2
   * @maxItems 3
   */
  arms:
    | ["known_good" | "incident" | "candidate", "known_good" | "incident" | "candidate"]
    | [
        "known_good" | "incident" | "candidate",
        "known_good" | "incident" | "candidate",
        "known_good" | "incident" | "candidate"
      ];
  cohorts: ["mobile", "desktop"];
  repeats: 3;
  assertions: ["checkout_completed", "order_created_count", "error_code"];
  /**
   * @minItems 3
   * @maxItems 4
   */
  required_controls:
    | [
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop",
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop",
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop"
      ]
    | [
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop",
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop",
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop",
        "known_good_mobile" | "known_good_desktop" | "incident_desktop" | "candidate_desktop"
      ];
  scope: string;
}

/* Generated from contracts/release-manifest.schema.json; do not edit. */

export interface FaultlineReleaseManifest {
  schema_version: 1;
  release_id: string;
  product: "Faultline";
  created_at: string;
  git_commit: string;
  profile: "core_offline" | "staging_enabled" | "connected";
  /**
   * @minItems 1
   * @maxItems 4
   */
  images:
    | [
        {
          name: string;
          digest: string;
        }
      ]
    | [
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        }
      ]
    | [
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        }
      ]
    | [
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        },
        {
          name: string;
          digest: string;
        }
      ];
  /**
   * @minItems 1
   * @maxItems 100
   */
  migrations: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 1000
   */
  evidence_ids: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 30
   */
  gates: [
    {
      id: string;
      status: "passed" | "failed" | "blocked" | "not_run" | "not_applicable";
      evidence_path: string | null;
      reason: string | null;
    },
    ...{
      id: string;
      status: "passed" | "failed" | "blocked" | "not_run" | "not_applicable";
      evidence_path: string | null;
      reason: string | null;
    }[]
  ];
  /**
   * @minItems 1
   * @maxItems 100
   */
  artifacts: [
    {
      path: string;
      sha256: string;
      size_bytes: number;
      media_type: string;
    },
    ...{
      path: string;
      sha256: string;
      size_bytes: number;
      media_type: string;
    }[]
  ];
  eligibility: "ineligible" | "release_ready" | "production_verified";
  /**
   * @minItems 0
   * @maxItems 30
   */
  limitations: string[];
}

/* Generated from contracts/report.schema.json; do not edit. */

export interface FaultlineReport {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  status: "draft" | "published" | "superseded" | "withdrawn";
  title: string;
  created_at: string;
  metric_hash: string;
  snapshot_hash: string;
  claim: FaultlineClaim;
  /**
   * @minItems 0
   * @maxItems 30
   */
  findings: {
    text: string;
    /**
     * @minItems 1
     * @maxItems 30
     */
    evidence_ids: [string, ...string[]];
    /**
     * @minItems 0
     * @maxItems 20
     */
    test_result_ids:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
  }[];
  /**
   * @minItems 0
   * @maxItems 10
   */
  alternatives:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  /**
   * @minItems 1
   * @maxItems 30
   */
  limitations: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 20
   */
  recommended_actions:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  follow_up: {
    due_at: string | null;
    metric_hash: string;
    /**
     * @minItems 1
     * @maxItems 20
     */
    required_source_intervals:
      | [
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ]
      | [
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          },
          {
            start: string;
            end: string;
          }
        ];
    mode: "observational";
    trigger_mode: "manual" | "due_check";
  } | null;
  /**
   * @minItems 0
   * @maxItems 100
   */
  artifact_files: {
    path: string;
    sha256: string;
    size_bytes: number;
    media_type: string;
  }[];
  input_manifest_hash: string;
}
export interface FaultlineClaim {
  association: "not_established" | "observed";
  mechanism: "untested" | "reproduced" | "not_reproduced" | "inconclusive";
  correction: "not_tested" | "validated" | "failed" | "inconclusive";
  attribution: {
    scope: "association_only";
    causal_effect: "not_established";
  };
  freshness: "fresh" | "stale";
  coverage_quality: "complete_attested" | "provisional" | "incomplete";
  scope: "synthetic_fixture" | "specified_snapshot_and_test_environment";
  warning: "LATE_ARRIVAL_ASSUMPTION" | null;
}

/* Generated from contracts/snapshot.schema.json; do not edit. */

export interface FaultlineSnapshot {
  schema_version: 1;
  id: string;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  source_id: string;
  adapter_version: string;
  created_at: string;
  content_hash: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  files: [
    {
      path: string;
      sha256: string;
      size_bytes: number;
      media_type: string;
    },
    ...{
      path: string;
      sha256: string;
      size_bytes: number;
      media_type: string;
    }[]
  ];
  coverage: FaultlineCoverage;
  record_count: number;
  source_mode: "fixture" | "live" | "file";
  /**
   * @minItems 0
   * @maxItems 100000
   */
  evidence_ids: string[];
}
export interface FaultlineCoverage {
  extraction_status: "complete" | "partial" | "unknown";
  basis: "source_guarantee" | "operator_attestation" | "lateness_assumption" | "none";
  covered_start: string | null;
  covered_end: string | null;
  event_watermark: string | null;
  attestation: string;
  /**
   * @minItems 0
   * @maxItems 100
   */
  event_time_intervals: {
    start: string;
    end: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 20
   */
  received_time_intervals?:
    | []
    | [
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ]
    | [
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        },
        {
          start: string;
          end: string;
        }
      ];
  /**
   * @minItems 0
   * @maxItems 20
   */
  assumptions?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}

/* Generated from contracts/target-grant.schema.json; do not edit. */

export interface FaultlineTargetGrant {
  id: string;
  workspace_id: string;
  /**
   * @minItems 1
   * @maxItems 10
   */
  origins:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  expires_at: string;
  revoked: boolean;
}

/* Generated from contracts/verification-result.schema.json; do not edit. */

export type FaultlineVerificationResult = {
  [k: string]: unknown;
} & {
  outcome: "passed" | "failed" | "blocked" | "inconclusive" | "not_run" | "cancelled";
  association: "not_established" | "observed";
  mechanism: "untested" | "reproduced" | "not_reproduced" | "inconclusive";
  correction: "not_tested" | "validated" | "failed" | "inconclusive";
  freshness: "fresh" | "stale";
  attribution: {
    scope: "association_only";
    causal_effect: "not_established";
  };
  /**
   * @minItems 0
   * @maxItems 30
   */
  reasons: string[];
  expected_runs: 12 | 18;
  observed_runs: number;
  plan_hash: string;
  mode: "trusted_fixture" | "verified_staging" | "exploratory";
  production_claim_eligible: boolean;
  workspace_id: string;
  case_id: string;
  revision_id: string;
  hypothesis_id: string;
  metric_hash: string;
  snapshot_hash: string;
};
